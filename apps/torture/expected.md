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
| `multi-page-checkout` | cart page (cookie banner covers "Proceed to shipping"), `Proceed to shipping` → shipping form (`Full name`, `Address`, `City`, `Country` select, `Continue to payment`) → review page (`Order note` and `Place order` in one form; risky: a batch halts `risky` before the click, and before an Enter in `Order note`, which would submit the form; finish with a single `kite click "Place order"`) → done page | `order:<name>:<country code>` (also POSTed to `/__last-result`) |
| `store-listing` | tabs (role=tab) `Store listing` (`Title`, `Summary` ≤ 132 chars with a counter, `Description`, `Category`, `Language`), `Privacy` (`Single purpose`, `debugger` / `nativeMessaging` / `tabs` / `host permissions` justification, radio `Does not collect user data`), `Package` (upload `Extension zip`, upload `Screenshots`, multiple). Hidden panels' fields exist only once their tab is clicked (lazy targets). `Save draft` validates every field, `Submit for review` is risky | `saved:{...values and file names}` after `Save draft`, then `submitted` |
| `showcase-listing` | the same fields and accessible names as `store-listing`, styled as a fictional developer console ("Lanternfly") for `docs/demo.gif` and the store screenshots: tabs `Store listing` (`Title`, `Summary`, `Description`, `Category`, `Language`, upload zone `Screenshots`), `Privacy`, `Package` (`Extension zip`). `Save draft` checks the Store listing fields only; `Submit for review` is risky | `saved:{...}` after `Save draft`, then `submitted` |
| `login` | `kite fill Username ada`, `kite fill Password <pw>`, `kite fill "One-time code" <code>`, `kite click "Sign in"` (password and one-time-code fields: secret, never cached or stored) | `signed-in:ada:ok` (never contains the password or code; also POSTed to `/__last-result`) |

`/navigating-link-done` is the navigation target of `navigating-link`. `/multi-page-checkout-shipping`, `-review` and `-done` are the next steps of `multi-page-checkout`. `/new-tab-target` is opened by `new-tab-link`; `/oauth` is opened (via `http://localhost:<port>`) by `oauth-popup`. `/analytics/*` returns 204.

`serial` (M2): records click order in `window.__events`. `kite click "Slow task"` (2 s progress bar) and a concurrent `kite click "Fast task"` on the same tab must give `["slow:start", "slow:end", "fast"]` — actions on one tab never interleave.
| `late-app` | `kite script`: `await click("Save")` right after load: the handler arrives 1.2 s later with the "bundle"; the click waits for it and lands once | `saved:1` |
| `swap-on-hover` | `kite script`: `await click("Pick me")`: the first hover removes the button and renders a new one 200 ms later; the missed press is sent again | `picked:1` (`picked:2` = sent twice) |
| `toggle` | `kite script`: `await click("Notifications")` | `flips:1` (`flips:2` = sent twice) |
| `late-list` | `kite script`: `waitFor({text: "@", within: "Timeline"})`, `waitFor({count: {selector: "article", min: 5}})` (the sidebar's "@" is there from the start) | `loaded` |
| `navigate-later` | `kite script`: `waitFor({text: "Arrived"})` across the navigation 300 ms after load | `arrived` |
