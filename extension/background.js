// Chrome runs this file alone as a service worker; Firefox loads shared.js first from the manifest.
globalThis.importScripts?.('shared.js')

const PAGE_URL = browser.runtime.getURL('history.html')
const MENU_ID = 'visual-history'
const PURGE_ALARM = 'purge-marked'
const PURGE_PORT = 'purge'
const PURGE_BATCH = 20

// Reuse an already open Visual History tab instead of stacking new ones.
async function openVisualHistory() {
  const tab = (await browser.tabs.query({})).find((t) => t.url === PAGE_URL)
  if (tab) {
    await browser.tabs.update(tab.id, { active: true })
    await browser.windows.update(tab.windowId, { focused: true })
  } else {
    await browser.tabs.create({ url: PAGE_URL })
  }
}

// WebExtensions cannot extend the History menu; Tools is the closest menu bar slot. Chrome has no menus API.
// Menus persist across event page restarts, so they are created once per install or update.
if (browser.menus) {
  browser.runtime.onInstalled.addListener(() => {
    browser.menus.create({ id: MENU_ID, title: browser.runtime.getManifest().name, contexts: ['tools_menu'] })
  })
  browser.menus.onClicked.addListener((info) => {
    if (info.menuItemId === MENU_ID) openVisualHistory()
  })
}
browser.action.onClicked.addListener(openVisualHistory)
browser.commands.onCommand.addListener((command) => {
  if (command === 'open-visual-history') openVisualHistory()
})

// One delete queue for the page and the daily purge. Pages connect a port and get live progress.
const purge = {
  pending: [], // { host, url } waiting to be deleted
  seen: new Map(), // url -> status in this run, so repeat clicks and re-scans only add new URLs
  hosts: new Map(), // host -> { total, deleted, failed }
  deleted: 0,
  failed: 0,
  draining: false
}
const ports = new Set()
const broadcast = (message) => ports.forEach((port) => port.postMessage(message))

function purgeState() {
  const hosts = [...purge.hosts].map(([host, stats]) => ({ host, ...stats }))
  return { type: 'state', running: purge.draining, total: purge.seen.size, deleted: purge.deleted, failed: purge.failed, hosts }
}

function addUrls(host, urls) {
  if (!purge.hosts.has(host)) purge.hosts.set(host, { total: 0, deleted: 0, failed: 0 })
  const stats = purge.hosts.get(host)
  for (const url of urls) {
    if (purge.seen.has(url)) continue
    purge.seen.set(url, 'queued')
    purge.pending.push({ host, url })
    stats.total++
  }
}

// Counts each outcome; a URL found again after deleting moves from deleted to failed.
function settle(items) {
  if (!items.length) return
  for (const { host, url, status } of items) {
    const before = purge.seen.get(url)
    if (before === 'deleted' || before === 'failed') {
      purge.hosts.get(host)[before]--
      purge[before]--
    }
    purge.seen.set(url, status)
    purge.hosts.get(host)[status]++
    purge[status]++
  }
  broadcast({ type: 'links', items })
  broadcast(purgeState())
}

// knownUrls adds entries the host text search may miss. A running delete picks up new hosts as they come.
async function queueHosts(targets) {
  for (const { host, urls = [] } of targets) addUrls(host, [...urls, ...(await hostItems(host)).map((i) => i.url)])
  broadcast(purgeState())
  drain()
}

async function drain() {
  if (purge.draining) return
  purge.draining = true
  broadcast(purgeState())
  do {
    while (purge.pending.length) {
      const batch = purge.pending.splice(0, PURGE_BATCH)
      broadcast({ type: 'links', items: batch.map((item) => ({ ...item, status: 'deleting' })) })
      // allSettled: one URL Firefox refuses must not stop the rest of the queue.
      const results = await Promise.allSettled(batch.map(({ url }) => browser.history.deleteUrl({ url })))
      settle(batch.map((item, i) => ({ ...item, status: results[i].status === 'fulfilled' ? 'deleted' : 'failed' })))
    }
    // Visits made while deleting, and entries the first search missed, get another round.
    for (const host of purge.hosts.keys()) {
      const urls = (await hostItems(host)).map((i) => i.url)
      settle(urls.filter((url) => purge.seen.get(url) === 'deleted').map((url) => ({ host, url, status: 'failed' })))
      addUrls(host, urls)
    }
  } while (purge.pending.length)

  purge.draining = false
  const done = purgeState()
  Object.assign(purge, { seen: new Map(), hosts: new Map(), deleted: 0, failed: 0 })
  broadcast(done)
  await Promise.all(done.hosts.map(({ host }) => browser.storage.local.remove(`preview:${host}`)))
}

// Firefox drops alarms on restart, so an hourly check against the last run keeps the purge daily.
async function purgeIfDue() {
  const { marked = [], lastPurge = 0 } = await browser.storage.local.get(['marked', 'lastPurge'])
  if (!marked.length || Date.now() - lastPurge < DAY || !(await autoPurgeEnabled())) return
  await browser.storage.local.set({ lastPurge: Date.now() })
  queueHosts(marked.map((host) => ({ host })))
}

// deleteRange drops only the old visits; pages visited again since then stay.
async function deleteOlderThan(days) {
  try {
    await browser.history.deleteRange({ startTime: 0, endTime: Date.now() - days * DAY })
  } finally {
    broadcast({ type: 'range', days })
  }
}

// Chrome restarts its service worker often; re-creating the alarm each time would keep re-arming the 1 minute delay.
browser.alarms.get(PURGE_ALARM).then((alarm) => alarm || browser.alarms.create(PURGE_ALARM, { delayInMinutes: 1, periodInMinutes: 60 }))
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PURGE_ALARM) purgeIfDue()
})
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== PURGE_PORT) return
  ports.add(port)
  port.onDisconnect.addListener(() => ports.delete(port))
  port.onMessage.addListener((message) => message.purge ? queueHosts(message.purge) : deleteOlderThan(message.olderThanDays))
  port.postMessage(purgeState())
})
