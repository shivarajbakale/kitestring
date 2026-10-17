# Torture pages: expected results

Serve with `pnpm --filter torture dev` (default http://127.0.0.1:4173). Each page leaves `window.__result` as `undefined` until its task is done; a wrong action sets `WRONG:<why>`.

| Page | CLI sequence | `__result` |
|---|---|---|
| `basic-form` | `bx fill Name Ada`, `bx fill Email ada@x.io`, `bx click Submit` | `submitted:Ada:ada@x.io` |
| `duplicate-buttons` | `bx click Save --within Profile` (Billing Save gives `WRONG:billing`) | `saved:profile` |
| `icon-only` | `bx click "Delete item"` | `deleted` |
| `covered-by-banner` | `bx click Continue` (status `blocked`), `bx click Accept`, `bx click Continue` | `continued` |
| `infinite-scroll` | `bx click "Item 57"` (finder scrolls, two loads needed) | `item:57` |
| `slow-button` | `bx click "Load data"` (result diff contains `Data ready`) | `loaded` |
| `never-idle` | `bx click Go` (returns `done` within 3000 ms) | `go` |
| `disabled-until-valid` | `bx click Submit` (`disabled`, errors contain `Enter a valid email`), `bx fill Email ada@x.io`, `bx click Submit` | `ok` |
| `rerender` | `bx snapshot`, wait 1 s, `bx click <ref of "Pick me">` | `picked` |
| `native-select` | `bx select Country India` | `country:IN` |
| `navigating-link` | `bx click "Next page"` (`done`, `navigation.url` ends `/navigating-link-done`) | `arrived` (set on `/navigating-link-done`) |
| `whitespace` | `bx click "  save changes "` | `saved` |

`/navigating-link-done` is the navigation target of `navigating-link`. `/analytics/*` returns 204.
