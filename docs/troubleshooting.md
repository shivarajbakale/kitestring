# Troubleshooting

Start with `kite doctor`. It is read-only and checks the Node version, the native host manifest and wrapper, the
socket, the extension connection, and each agent's MCP entry and skills, printing a fix hint for anything failing.
Host logs are in `$KITE_HOME/logs/host.log` (`$KITE_HOME` defaults to `~/.kitestring`).

## Common errors

| What you see | What it means and what to do |
| --- | --- |
| `NOT_CONNECTED` (exit 2) | The extension is not talking to the native host. Run `kite install-host` (or `kite init`), then reload the extension or restart Chrome, and check `kite status`. |
| `kite: timed out waiting for the browser` | The browser did not answer within 60 s. Check that Chrome is running and the extension is enabled; `KITE_TIMEOUT_MS` changes the bound. |
| `PAUSED` | Someone paused agents from the popup, the side panel or `kite pause`. Run `kite resume` or press Resume. |
| `NO_TAB` | The session has no tab yet. Open one with `kite tab new <url>`. |
| `NOT_OWNER` | The tab belongs to another session. Use `--session <name>` or open your own tab. |
| `restricted page (about:blank)` | A blank tab: run `kite goto <url>`. |
| `restricted page (…) — browser blocks extensions here` | `chrome://` pages, the Chrome Web Store and similar pages can't be automated by any extension. |
| `BAD_REQUEST: refusing to upload <path>: <reason>` | The upload deny list refused the file. See [Upload](reference.md#upload); `KITE_UPLOAD_ALLOW` overrides the location rules. |
| batch `halted … (risky)` | A click looked like pay, send, delete or publish, and nothing was clicked. If you mean it, run that one click on its own with `kite click`. |
| The "started debugging this browser" bar | Expected while kite acts on a tab. If you cancel it, the next action attaches again. |
| `kite: command not found` | `~/.kitestring/bin` is not on your `PATH`. Add `export PATH="$HOME/.kitestring/bin:$PATH"` to your shell profile and open a new terminal, or use `node packages/cli/dist/bin.js`. |

## Coming from the old `bx`

Run `kite install-host`. It removes the legacy `com.bx.bridge` manifest and writes `com.kitestring.bridge`. Then
reload the extension. `~/.bx` is no longer used and can be deleted when you are ready (kite never deletes it for
you).

## Verify with Codex (manual)

Codex's desktop app is not scripted, so check it by hand:

1. Run `kite init --agents codex` and confirm `~/.codex/config.toml` has a `[mcp_servers.kitestring]` table.
2. Fully quit and reopen the Codex desktop app so it reloads its config.
3. Start the torture site (`pnpm --filter torture dev`) and a new Codex thread, and send: `Use the kitestring tools:
   open http://127.0.0.1:4173/basic-form, fill Name with Ada and Email with ada@x.io, submit, then report the page's
   window.__result via a snapshot of the confirmation`.
4. Approve the `kitestring` tool calls if asked. Expect the reply to mention `submitted:Ada:ada@x.io`, and the
   activity list in the popup to show the calls.

## Agent smoke test

`scripts/agent-smoke.sh [claude|opencode] --yes` starts the torture site, has a real agent fill the form through the
MCP tools, then checks that the site recorded `submitted:Ada:ada@x.io`. It refuses to run unless `kite doctor`
reports the bridge and extension as ok, **spends your agent credits**, needs an explicit `--yes` (or an interactive
confirm), and must never run in CI.

## Windows

Windows: untested. The code for it (a named pipe, `\\.\pipe\kitestring-<username>`, and Windows install paths for the
native host) is in place and covered by unit tests with a mocked platform, but nobody has run it on a real Windows
machine yet. Reports are welcome.

## End-to-end tests

- `extension or CLI not built — run pnpm build first`: the e2e suite does not build anything; run `pnpm build`.
- Playwright's Chromium is missing: `pnpm --filter @kitestring/e2e exec playwright install chromium`.
- Branded Chrome ≥ 137 ignores `--load-extension`, which is why the suite uses Playwright's Chromium.
