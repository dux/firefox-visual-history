const RANGE = 365 * DAY
const DOMAINS_PER_PAGE = 50
const LINKS_PER_PAGE = 15
const LINK_COUNT = 7
const PREVIEW_TTL = 7 * DAY
const FETCH_TIMEOUT = 10000
const MAX_TEXT = 100
const LOG_ROWS = 200

const IMAGE_SELECTORS = [
  'meta[property="og:image"]',
  'meta[property="og:image:url"]',
  'meta[name="og:image"]',
  'meta[name="twitter:image"]',
  'meta[property="twitter:image"]',
  'meta[name="twitter:image:src"]',
  'meta[itemprop="image"]'
]
const ICON_SELECTORS = ['link[rel~="apple-touch-icon"]', 'link[rel~="icon"]']
const TITLE_SELECTORS = ['meta[property="og:title"]', 'meta[name="twitter:title"]']
const DESCRIPTION_SELECTORS = ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']

const state = {
  domains: [], // last year of history grouped by host
  visible: [], // domains after filter and sort
  page: 0,
  detail: null, // { domain, page } while a single domain is focused
  marked: [], // hosts deleted before, persisted in storage
  counts: new Map(), // current all-time link count per marked host
  purge: null, // latest progress of the background delete queue
  rangeCounts: new Map(), // days -> links whose last visit is older, so a range delete removes them entirely
  rangeRunning: false // a "Delete older than" delete is in flight
}
const pageMeta = new Map()

const $ = (sel) => document.querySelector(sel)
const view = $('#view')
const filterInput = $('#filter')
const sortSelect = $('#sort')
const autoPurgeInput = $('#auto-purge')
const rangeButtons = [...document.querySelectorAll('#ranges button')]
const purgeDialog = $('#purge')
const purgeLog = $('#purge-log')
const logRows = new Map() // url -> row in purgeLog
const purgePort = browser.runtime.connect({ name: 'purge' })

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (value != null) node.setAttribute(key, value)
  }
  node.append(...children.filter((c) => c != null))
  return node
}

const show = (...nodes) => view.replaceChildren(...nodes.filter(Boolean))
const message = (text) => el('p', { class: 'empty' }, text)
const domainHref = (host) => `#domain=${encodeURIComponent(host)}`
const pageCount = (length, size) => Math.ceil(length / size)
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
const clip = (text) => text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text

function ago(ts) {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })
  const diff = (ts - Date.now()) / 1000
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit)
  }
  return 'just now'
}

function buildDomain(host, items) {
  items.sort((a, b) => b.lastVisitTime - a.lastVisitTime)
  return {
    host,
    items,
    visits: items.reduce((sum, i) => sum + (i.visitCount || 0), 0),
    last: items[0]?.lastVisitTime || 0,
    origin: items.length ? new URL(items[0].url).origin : `https://${host}`
  }
}

// All-time history of one host, which is exactly what deleting the host removes.
async function domainHistory(host) {
  return buildDomain(host, await hostItems(host))
}

async function loadHistory() {
  const items = await browser.history.search({ text: '', startTime: Date.now() - RANGE, maxResults: MAX_RESULTS })
  const byHost = new Map()
  for (const item of items) {
    const host = hostKey(item.url)
    if (!host) continue
    if (!byHost.has(host)) byHost.set(host, [])
    byHost.get(host).push(item)
  }
  state.domains = [...byHost].map(([host, list]) => buildDomain(host, list))
}

async function route(reload = false) {
  const match = location.hash.match(/^#domain=(.+)$/)
  const host = match && decodeURIComponent(match[1])
  $('#list-controls').hidden = !!host
  $('#ranges').hidden = !!host
  const name = browser.runtime.getManifest().name
  document.title = host ? `${host} - ${name}` : name
  if (!host) {
    state.detail = null
    return applyView()
  }
  const same = state.detail?.domain.host === host
  if (!same) {
    show(message('Loading history...'))
    window.scrollTo(0, 0)
  }
  if (!same || reload) state.detail = { domain: await domainHistory(host), page: same ? state.detail.page : 0 }
  state.detail.page = Math.min(state.detail.page, Math.max(0, pageCount(state.detail.domain.items.length, LINKS_PER_PAGE) - 1))
  renderDetail()
}

function applyView() {
  const query = filterInput.value.trim().toLowerCase()
  const sorters = {
    recent: (a, b) => b.last - a.last,
    visits: (a, b) => b.visits - a.visits,
    name: (a, b) => a.host.localeCompare(b.host)
  }
  const banned = new Set(state.marked)
  const listed = state.domains.filter((d) => !banned.has(d.host))
  state.visible = listed.filter((d) => d.host.includes(query)).sort(sorters[sortSelect.value])
  state.page = Math.min(state.page, Math.max(0, pageCount(state.visible.length, DOMAINS_PER_PAGE) - 1))
  const pages = listed.reduce((sum, d) => sum + d.items.length, 0)
  $('#summary').textContent = `${plural(listed.length, 'domain')}, ${plural(pages, 'page')} in the last year`
  renderList()
}

function goToPage(page) {
  const target = state.detail || state
  const total = state.detail ? pageCount(state.detail.domain.items.length, LINKS_PER_PAGE) : pageCount(state.visible.length, DOMAINS_PER_PAGE)
  if (page < 0 || page >= total) return
  target.page = page
  state.detail ? renderDetail() : renderList()
  window.scrollTo(0, 0)
}

function pager(page, total) {
  if (total < 2) return null
  const button = (label, to, disabled) => el('button', { onclick: () => goToPage(to), disabled: disabled ? '' : null }, label)
  return el('nav', { class: 'pager' },
    button('First', 0, page === 0),
    button('Prev', page - 1, page === 0),
    el('span', {}, `Page ${page + 1} of ${total}`),
    button('Next', page + 1, page >= total - 1),
    button('Last', total - 1, page >= total - 1)
  )
}

function renderList() {
  const total = pageCount(state.visible.length, DOMAINS_PER_PAGE)
  const start = state.page * DOMAINS_PER_PAGE
  const domains = state.visible.slice(start, start + DOMAINS_PER_PAGE)
  show(
    pager(state.page, total),
    domains.length ? el('table', {}, el('tbody', {}, ...domains.map((d) => renderDomain(d)))) : message('No history found.'),
    pager(state.page, total)
  )
}

function renderDetail() {
  const { domain, page } = state.detail
  const total = pageCount(domain.items.length, LINKS_PER_PAGE)
  const start = page * LINKS_PER_PAGE
  show(
    el('a', { class: 'back', href: '#' }, 'Back to all domains'),
    domain.items.length ? el('table', {}, el('tbody', {}, renderDomain(domain, true))) : message(`No history left for ${domain.host}.`),
    pager(page, total),
    domain.items.length ? el('ol', { class: 'expanded' }, ...domain.items.slice(start, start + LINKS_PER_PAGE).map((i) => renderLink(domain, i))) : null,
    pager(page, total)
  )
}

// Domain row; focused rows link out to the site and leave the link list to renderDetail.
function renderDomain(domain, focused = false) {
  const href = focused ? domain.origin : domainHref(domain.host)
  const shot = el('a', { class: 'shot loading', href, title: focused ? domain.origin : `Show all links of ${domain.host}` }, 'Loading preview...')
  const favicon = el('img', { src: `${domain.origin}/favicon.ico`, alt: '', onerror: () => favicon.remove() })
  const deleteButton = el('button', { class: 'delete', onclick: () => deleteDomain(domain) }, 'Delete all history for this domain')
  const about = focused ? el('p', { class: 'about' }) : null

  const links = focused ? null : domain.items.slice(0, LINK_COUNT).map((item) => {
    const url = new URL(item.url)
    const path = url.pathname + url.search
    return el('li', {},
      el('a', { href: item.url, title: item.url }, clip(item.title || path)),
      el('time', { title: new Date(item.lastVisitTime).toLocaleString() }, ago(item.lastVisitTime))
    )
  })

  getPreview(domain).then((preview) => {
    if (preview.icon) favicon.src = preview.icon
    if (about) about.textContent = preview.description || ''
    fillShot(shot, 'shot', preview, domain.host)
  })

  return el('tr', {},
    el('td', { class: 'preview' }, shot, deleteButton),
    el('td', { class: 'links' },
      el('h2', {}, favicon, el('a', { href }, domain.host)),
      el('div', { class: 'meta' }, `${plural(domain.items.length, 'page')}, ${plural(domain.visits, 'visit')}, last ${ago(domain.last)}`),
      about,
      links && el('ol', {}, ...links)
    )
  )
}

function renderLink(domain, item) {
  const shot = el('a', { class: 'shot small loading', href: item.url }, 'Loading...')
  const title = el('a', { class: 'title', href: item.url, title: item.url }, clip(item.title || item.url))
  const description = el('p', { class: 'description' })

  getPageMeta(item.url).then((meta) => {
    if (!item.title && meta.title) title.textContent = clip(meta.title)
    description.textContent = meta.description || ''
    fillShot(shot, 'shot small', meta, domain.host)
  })

  return el('li', {},
    shot,
    el('div', { class: 'body' },
      title,
      el('a', { class: 'url', href: item.url, title: item.url }, clip(item.url)),
      description,
      el('time', { title: new Date(item.lastVisitTime).toLocaleString() }, `${ago(item.lastVisitTime)}, ${plural(item.visitCount || 0, 'visit')}`)
    )
  )
}

// Shows the preview image, else the icon, else the first letter of the host.
function fillShot(shot, base, { image, icon }, host) {
  const candidates = [image && { src: image, cls: base }, icon && { src: icon, cls: `${base} icon` }].filter(Boolean)
  const tryNext = () => {
    const next = candidates.shift()
    if (!next) {
      shot.className = base
      shot.replaceChildren(host[0])
      return
    }
    const img = el('img', { alt: '', referrerpolicy: 'no-referrer' })
    img.onload = () => {
      shot.className = next.cls
      shot.replaceChildren(img)
    }
    img.onerror = tryNext
    img.src = next.src
  }
  tryNext()
}

async function getPreview(domain) {
  const key = `preview:${domain.host}`
  const cached = (await browser.storage.local.get(key))[key]
  if (cached && Date.now() - cached.at < PREVIEW_TTL) return cached
  const preview = { ...(await fetchMeta(`${domain.origin}/`)), at: Date.now() }
  await browser.storage.local.set({ [key]: preview })
  return preview
}

// Link metadata is cached for the page session only, so storage does not grow per visited URL.
function getPageMeta(url) {
  if (!pageMeta.has(url)) pageMeta.set(url, fetchMeta(url))
  return pageMeta.get(url)
}

// Reads a page and pulls its social preview image, best icon, title and description.
async function fetchMeta(url) {
  const fallback = { image: null, icon: new URL('/favicon.ico', url).href, title: null, description: null }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'omit' })
    if (!(res.headers.get('content-type') || '').includes('html')) return fallback
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
    const pickText = (selectors, attr = 'content') => {
      for (const selector of selectors) {
        const value = doc.querySelector(selector)?.getAttribute(attr)?.trim()
        if (value) return value
      }
      return null
    }
    const pickUrl = (selectors, attr) => {
      const value = pickText(selectors, attr)
      try {
        return value && new URL(value, res.url).href
      } catch {
        return null
      }
    }
    return {
      image: pickUrl(IMAGE_SELECTORS, 'content'),
      icon: pickUrl(ICON_SELECTORS, 'href') || new URL('/favicon.ico', res.url).href,
      title: pickText(TITLE_SELECTORS) || doc.title.trim() || null,
      description: pickText(DESCRIPTION_SELECTORS)
    }
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

// The background script deletes, so it keeps going when this tab closes; progress comes back over purgePort.
function deleteHosts(hosts) {
  const purge = hosts.map((host) => ({ host, urls: (state.domains.find((d) => d.host === host)?.items || []).map((i) => i.url) }))
  state.marked = [...new Set([...state.marked, ...hosts])]
  state.domains = state.domains.filter((d) => !hosts.includes(d.host))
  browser.storage.local.set({ marked: state.marked })
  openPurge()
  purgePort.postMessage({ purge })
  renderMarked()
}

// A new run starts with an empty log; a running one keeps its log and gets the new links appended.
function openPurge() {
  if (!state.purge?.running) {
    $('#purge-title').textContent = 'Deleting history'
    $('#purge-status').textContent = 'Collecting links...'
    $('#purge-progress').removeAttribute('value')
    $('#purge-hosts').replaceChildren()
    $('#purge-close').textContent = 'Hide, keep deleting'
    purgeLog.replaceChildren()
    logRows.clear()
  }
  if (!purgeDialog.open) purgeDialog.showModal()
}

function onPurgeMessage(message) {
  if (message.type === 'links') return logLinks(message.items)
  if (message.type === 'range') return rangeDeleted(message.days)
  const first = !state.purge
  const finished = state.purge?.running && !message.running
  state.purge = message
  if (message.total || message.running) renderPurge()
  renderMarked()
  if (first && message.running) openPurge()
  if (finished) reloadAfterPurge()
}

function renderPurge() {
  const { running, total, deleted, failed, hosts } = state.purge
  const progress = $('#purge-progress')
  progress.max = total || 1
  progress.value = running ? deleted + failed : progress.max
  $('#purge-title').textContent = running ? 'Deleting history' : 'History deleted'
  $('#purge-status').textContent = `${deleted.toLocaleString()} of ${plural(total, 'link')} deleted${failed ? `, ${failed.toLocaleString()} failed` : ''}`
  $('#purge-hosts').replaceChildren(...hosts.map((h) => el('span', { class: h.failed ? 'chip pending' : 'chip' }, h.host, el('b', {}, `${h.deleted.toLocaleString()} / ${h.total.toLocaleString()}`))))
  $('#purge-close').textContent = running ? 'Hide, keep deleting' : 'Close'
}

// Newest links on top; a link turns from deleting to deleted or failed in place.
function logLinks(items) {
  const fresh = []
  for (const { url, status } of items) {
    if (!logRows.has(url)) {
      logRows.set(url, el('li', { title: url }, clip(url.replace(/^https?:\/\//, ''))))
      fresh.push(logRows.get(url))
    }
    logRows.get(url).className = status
  }
  purgeLog.prepend(...fresh.reverse())
  while (logRows.size > LOG_ROWS) {
    logRows.delete(purgeLog.lastElementChild.title)
    purgeLog.lastElementChild.remove()
  }
}

async function reloadAfterPurge() {
  await Promise.all([loadHistory(), refreshCounts(), refreshRangeCounts()])
  route(true)
}

function deleteDomain(domain) {
  deleteHosts([domain.host])
  if (state.detail) location.hash = ''
  else route()
}

function deleteMarked() {
  deleteHosts(state.marked.filter((host) => state.counts.get(host)))
  route()
}

// The background script runs it, so it finishes even when this tab closes.
function deleteOlderThan(button) {
  state.rangeRunning = true
  renderRanges()
  $('#range-status').textContent = `Deleting history older than ${button.dataset.label}...`
  purgePort.postMessage({ olderThanDays: Number(button.dataset.days) })
}

function rangeDeleted(days) {
  state.rangeRunning = false
  $('#range-status').textContent = `Deleted history older than ${rangeButtons.find((b) => Number(b.dataset.days) === days).dataset.label}.`
  reloadAfterPurge()
}

async function refreshRangeCounts() {
  const items = await browser.history.search({ text: '', startTime: 0, maxResults: MAX_RESULTS })
  const now = Date.now()
  state.rangeCounts = new Map(rangeButtons.map((b) => {
    const cutoff = now - Number(b.dataset.days) * DAY
    return [b.dataset.days, items.filter((i) => i.lastVisitTime < cutoff).length]
  }))
  renderRanges()
}

function renderRanges() {
  for (const button of rangeButtons) {
    const count = state.rangeCounts.get(button.dataset.days) || 0
    button.textContent = `${button.dataset.label} (${count.toLocaleString()})`
    button.disabled = state.rangeRunning || !count
  }
}

async function forget(host) {
  state.marked = state.marked.filter((h) => h !== host)
  state.counts.delete(host)
  await browser.storage.local.set({ marked: state.marked })
  renderMarked()
  if (!state.detail) applyView()
}

async function refreshCounts() {
  const counts = await Promise.all(state.marked.map(async (host) => [host, (await domainHistory(host)).items.length]))
  state.counts = new Map(counts)
  renderMarked()
}

function renderMarked() {
  const bar = $('#marked')
  if (!state.marked.length) return bar.replaceChildren()
  const total = [...state.counts.values()].reduce((sum, n) => sum + n, 0)
  const chips = [...state.marked].sort().map((host) => {
    const count = state.counts.get(host) || 0
    return el('span', { class: count ? 'chip pending' : 'chip' },
      el('a', { href: domainHref(host), title: `${count.toLocaleString()} links in history` }, host, el('b', {}, count.toLocaleString())),
      el('button', { title: 'Forget this domain', onclick: () => forget(host) }, 'x')
    )
  })
  const deleteAll = state.purge?.running
    ? el('button', { class: 'delete', onclick: openPurge }, 'Deleting... show progress')
    : el('button', { class: 'delete', disabled: total ? null : '', onclick: deleteMarked }, `Delete all (${total.toLocaleString()})`)
  bar.replaceChildren(el('span', { class: 'label' }, 'Banned domains'), ...chips, deleteAll)
}

filterInput.addEventListener('input', () => {
  state.page = 0
  applyView()
})
sortSelect.addEventListener('change', () => {
  state.page = 0
  applyView()
})
rangeButtons.forEach((button) => button.addEventListener('click', () => deleteOlderThan(button)))
autoPurgeInput.addEventListener('change', () => browser.storage.local.set({ autoPurge: autoPurgeInput.checked }))
document.addEventListener('keydown', (event) => {
  if (purgeDialog.open || event.target.matches('input, select')) return
  const page = (state.detail || state).page
  if (event.key === 'ArrowLeft') goToPage(page - 1)
  if (event.key === 'ArrowRight') goToPage(page + 1)
})
// Marked domains collect new visits while this tab is in the background.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  refreshCounts()
  refreshRangeCounts()
  if (state.detail) route(true)
})
purgePort.onMessage.addListener(onPurgeMessage)
window.addEventListener('hashchange', () => route())

async function init() {
  show(message('Loading history...'))
  state.marked = (await browser.storage.local.get('marked')).marked || []
  autoPurgeInput.checked = await autoPurgeEnabled()
  await Promise.all([loadHistory(), refreshCounts(), refreshRangeCounts()])
  route()
}

init()
