// Chrome only has chrome.*; under MV3 it returns promises like browser.*.
globalThis.browser ??= chrome

const DAY = 864e5
const MAX_RESULTS = 1e6

// Groups by hostname; "www." is folded into the bare host.
function hostKey(url) {
  if (!/^https?:/.test(url)) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

// All-time history of one host, which is exactly what purgeHost removes.
async function hostItems(host) {
  const found = await browser.history.search({ text: host, startTime: 0, maxResults: MAX_RESULTS })
  return found.filter((i) => hostKey(i.url) === host)
}

// Daily background delete of the banned domains; on unless switched off on the page.
const autoPurgeEnabled = async () => (await browser.storage.local.get('autoPurge')).autoPurge ?? true
