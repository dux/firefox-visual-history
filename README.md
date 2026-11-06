# Visual history by dux

Firefox extension that shows the last year of browsing history grouped by domain.
Each row shows a preview image of the domain root page, the domain with its 7 latest links, and a button that deletes all history for that domain.
Pages show 50 domains each.

## Opening it

* Tools menu (menu bar) -> Visual history by dux. WebExtensions cannot add items to the History menu, so Tools is the closest spot.
* Toolbar button.
* `Alt+Shift+H`.

## How it works

* History comes from `browser.history.search` for the last 365 days, grouped by hostname with `www.` folded in (`mail.google.com` and `google.com` are separate rows).
* The preview image is the root page's `og:image` / `twitter:image`. Without one, the page's apple-touch-icon or favicon is shown, then the first letter of the domain.
  Previews are fetched on demand for the visible page and cached for 7 days in `storage.local`.
* Delete removes every history entry for the hostname and its `www.` variant, from all time, not only the last year.
* Deleted domains are remembered in `storage.local` as banned domains and shown on top as buttons with their current link count, so new visits since the delete are visible.
  Banned domains are left out of the domain list and its summary, even when they have new visits; "x" puts a domain back.
  Counts refresh when the tab becomes visible again. "Delete all" removes the history of every remembered domain; "x" forgets a domain.
* Deletes run in one queue in the background script, so they keep going when the extension's tab closes.
  Deleting another domain while a delete runs adds its links to the same queue.
  When the queue is empty, the background script searches every host in the run again and deletes anything new, such as visits made while deleting.
  A URL that Firefox refuses, or that is still in history after deleting, is counted as failed and does not stop the rest.
* A dialog shows the delete live: progress bar, deleted/total per domain, and the latest 200 links (URL capped at 100 chars) as they go from deleting to deleted or failed.
  "Hide, keep deleting" closes it; "Deleting... show progress" in the banned domains bar opens it again.
  Opening the page during a running delete opens it too.
* Every remembered domain is purged automatically once a day through the same queue, while "Bg delete of banned domains" is checked (on by default, saved as `autoPurge` in `storage.local`).
  The background script checks hourly and runs when 24 hours have passed since `lastPurge` in `storage.local`, since Firefox drops alarms on restart.
* "Delete history older than" 1 year, 3 months, 1 month, 1 week or 0 days (everything) calls `browser.history.deleteRange` in the background script, without confirmation.
  Only visits older than the cutoff go; a page visited again since then stays with its newer visits.
  Each button shows how many links go entirely (last visit before the cutoff) and is disabled at 0; counts refresh after deletes and when the tab becomes visible.
* Clicking a domain opens its own view (`#domain=<host>`) with all its links from all time, 15 per page.
  Each link shows the page's preview image, title, URL and description, fetched on demand and cached for the tab session.
  In that view the domain name and preview link to the site itself.
* Rows can be filtered by domain and sorted by most recent visit, visit count or name. Left/right arrow keys change pages.

## Install

Temporary (removed when Firefox restarts):

* `about:debugging#/runtime/this-firefox` -> Load Temporary Add-on -> pick `./manifest.json`.

Permanent:

* Release Firefox only installs signed add-ons. Sign it as unlisted (self-distributed) with AMO API keys from https://addons.mozilla.org/developers/addon/api/key/:
  `npx web-ext sign --channel unlisted --api-key ... --api-secret ...`, then open the `.xpi` from `./web-ext-artifacts/` in Firefox.
* Firefox Developer Edition, Nightly or ESR: set `xpinstall.signatures.required` to `false` in `about:config`, run `npx web-ext build`, then install the zip from `about:addons` -> gear -> Install Add-on From File.

## Development

* `npx web-ext run` starts Firefox with the extension loaded and reloads it on change.
* `npx web-ext lint` validates the manifest and code.
