# Recovery reference

Two kinds of failure:

- **Action status** — the action ran and reports why it did not succeed (`✗ <status>: <detail>`; CLI exit code 1).
- **RPC error** — the call did not run. CLI prints `kite: <message>` on stderr (exit 1; exit 2 for NOT_CONNECTED); only some messages contain the code, so recognise them by the text below, or use `--json` to get `{"error":{"code":"…","message":"…"}}` on stdout. MCP returns an error result with text `<CODE>: <message>`.

Rule for all of them: **never repeat the identical call unchanged.** Change something based on the detail, or stop and tell the human.

## Action statuses

| Status | Meaning | Do |
|---|---|---|
| `done` | Acted; page settled. | Read the diff. Continue. A click with an empty diff ran a handler but changed nothing visible: suspect a thrown error or failed request, check `kite console --errors` and `kite network --failed`. |
| `not_found` | No element matches (after scrolling up to 3 viewports), or it is hidden, or the ref is stale. | `kite snapshot` (`--full` on long pages). Retry with the exact name shown, or its ref. Maybe it is behind a menu/tab: open that first. |
| `ambiguous` | Two or more close matches. `candidates:` lists them. | Click the right candidate's ref, or add `--within "<section>"` / `--role <role>`. Never guess the first one for a consequential action. |
| `blocked` | Another element covers the target; `blockedBy` / detail names it (cookie banner, modal, overlay). | Deal with the cover (e.g. `kite click "Accept"` on a cookie banner, close a dialog), then retry. If the cover asks for a consequential choice, ask the human. |
| `disabled` | Target is disabled; detail / `!` lines carry visible form errors. | Fix the inputs those errors name (`kite fill …`), then retry. Do not hunt for ways to force-click it. |
| `no_effect` | Clicked, but no click handler received it and nothing changed: no diff, same URL, no new tab. | Do not click again blindly. Check `kite console --errors` and `kite network --failed`; screenshot if the change might be visual only. Report what you found. |
| `timeout` | The page did not settle in 10 s, or another action held the tab. The action may still have happened. | `kite snapshot` to see the real state before doing anything else. Never re-submit a form after a timeout without checking it did not go through. |
| `restricted` | Browser forbids extensions on this page. | `kite goto <url>` to a normal http(s) page. |
| `error` | Acted but failed: no such option in a select, navigation failed, filled value did not stick. | Read the detail; fix the value (check the options in a snapshot) or the URL. |

## RPC error codes

| Code | CLI message looks like | Meaning | Do |
|---|---|---|---|
| `NOT_CONNECTED` | `browser not connected (is Chrome open with the Kitestring extension?)` | The CLI cannot reach the browser. | Run `kite doctor` and show the human the failing `fix:` lines (setup steps such as `kite init` or loading the extension in Chrome are theirs to run), then check `kite status` (`browser_status`). Do not try to install or launch anything yourself. |
| `NO_TAB` | `NO_TAB: session "…" has no active tab …` | Your session has no active tab. | `kite tab new <url>`. |
| `NOT_OWNER` | `NOT_OWNER: tab … does not belong to session "…"` | The tab id belongs to another session (another agent or task). | Leave it alone. `kite tab list` shows your tabs; `kite tab use <id>` one of them or open a new one. |
| `RESTRICTED` | `restricted page (<url>) — browser blocks extensions here` | The active tab is a page extensions cannot touch (chrome://, Chrome Web Store, `about:blank`). | `kite goto <url>`. |
| `BAD_REQUEST` | `unknown key "…" (supported: …)`, `params.… must …` | Your arguments are invalid: unknown key name, malformed ref, ref not on the page, bad option value. | Read the message (it lists valid values); fix the call. For `kite press`, use names like Enter, Escape, Tab, ArrowDown. |
| `TIMEOUT` | `timed out waiting for the browser` | The browser did not answer in time. | `kite status`. Retry once. Still failing: tell the human the page seems stuck. |
| `INTERNAL` | `connection closed before response`, `malformed response from host`, other | Unexpected failure in Kitestring. | Retry once. Then report the exact message to the human. |
| `PAUSED` | `PAUSED: Kitestring is paused by the user (<reason>)` | **The human pressed pause.** Every action is refused until they resume. | Stop acting. Do not retry, do not loop on `kite status`, do not run `kite resume`. Tell the human what you were doing and what is left, and wait for their answer. |

`kite status`, `kite tab list` and `kite activity` still answer while paused, so you can report state.
