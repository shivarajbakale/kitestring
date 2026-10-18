# Torture pages: expected results

Serve with `pnpm --filter torture dev` (default http://127.0.0.1:4173). Each page leaves `window.__result` as `undefined` until its task is done; a wrong action sets `WRONG:<why>`.

| Page | CLI sequence | `__result` |
|---|---|---|
| `basic-form` | `kite fill Name Ada`, `kite fill Email ada@x.io`, `kite click Submit` | `submitted:Ada:ada@x.io` |
| `duplicate-buttons` | `kite click Save --within Profile` (Billing Save gives `WRONG:billing`) | `saved:profile` |
| `icon-only` | `kite click "Delete item"` | `deleted` |
| `covered-by-banner` | `kite click Continue` (status `done`; the cookie banner is closed first: `closed popup cookie "Accept"`) | `continued` |
| `covered-by-overlay` | `kite click Continue` (status `blocked`, a maintenance notice is not a cookie wall or newsletter), `kite click OK`, `kite click Continue` | `continued` |
| `cookie-wall` | `kite click Continue` (`done`, `closed popup cookie "Reject all"`) | `continued:none` |
| `newsletter-modal` | wait 700 ms, `kite click "Read article"` (the newsletter modal is closed with `Close`, never `Subscribe`) | `read` |
| `infinite-scroll` | `kite click "Item 57"` (finder scrolls, two loads needed) | `item:57` |
| `slow-button` | `kite click "Load data"` (result diff contains `Data ready`) | `loaded` |
| `never-idle` | `kite click Go` (returns `done` within 3000 ms) | `go` |
| `disabled-until-valid` | `kite click Submit` (`disabled`, errors contain `Enter a valid email`), `kite fill Email ada@x.io`, `kite click Submit` | `ok` |
| `rerender` | `kite snapshot`, wait 1 s, `kite click <ref of "Pick me">` | `picked` |
| `native-select` | `kite select Country India` | `country:IN` |
| `navigating-link` | `kite click "Next page"` (`done`, `navigation.url` ends `/navigating-link-done`) | `arrived` (set on `/navigating-link-done`) |
| `whitespace` | `kite click "  save changes "` | `saved` |
| `alert-box` | `kite click "Show alert"` (`done` within 3 s, `dialogs[0]` is the accepted alert), `kite click "Delete everything"` (confirm dismissed), `kite click Rename` (prompt dismissed) | `kept` / `rename-cancelled` (`WRONG:deleted` if the confirm was accepted) |
| `file-upload` | `kite upload "Extension zip" kite.zip`, `kite upload "Choose screenshots" s1.png s2.png` (hidden `multiple` input behind a button), `kite upload "Drop icon here" icon.png` (drop zone: detached input, file-chooser fallback) | `{"a":["kite.zip"],"b":["s1.png","s2.png"],"c":["icon.png"]}` |
| `new-tab-link` | `kite click "Open report"` (lists `⧉ new tab <id>`; `kite tab list` includes it), `kite tab use <id>`, `kite click "Confirm report"` | `report-confirmed` (also POSTed to `/__last-result`) |
| `oauth-popup` | `kite click "Sign in with Kite"` (opens a popup window on `localhost`, another registrable domain), `kite tab use <popup id>`, `kite click Allow` (popup closes, opener is the active tab again) | `signed-in` (set on the opener by `postMessage`) |

`/navigating-link-done` is the navigation target of `navigating-link`. `/new-tab-target` is opened by `new-tab-link`; `/oauth` is opened (via `http://localhost:<port>`) by `oauth-popup`. `/analytics/*` returns 204.

`serial` (M2): records click order in `window.__events`. `kite click "Slow task"` (2 s progress bar) and a concurrent `kite click "Fast task"` on the same tab must give `["slow:start", "slow:end", "fast"]` — actions on one tab never interleave.
