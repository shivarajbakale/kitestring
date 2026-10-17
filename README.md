<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
    <img src="brand/lockup.svg" alt="Kitestring" width="360">
  </picture>
</h1>

Kitestring lets AI agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode) drive your real Chrome: your profile, your logins, your tabs. You can drive it from a terminal too, with `kite`.

It is an unpacked developer install for now: there is no Chrome Web Store listing yet, and it supports macOS and Linux only.

## Quickstart

```sh
git clone <this repo> && cd bx
pnpm i && pnpm build
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `packages/extension/build/chrome-mv3-prod`. The card should show ID `bdfegcbeenjmlbfogodoibdhfbonnicm`.
2. Register Kitestring with your agents:

   ```sh
   alias kite="node $PWD/packages/cli/dist/bin.js"
   kite init              # or: node packages/cli/dist/bin.js init
   ```

   `kite init` adds the `kitestring` MCP server to every supported agent it finds (Claude Code, Codex, Cursor, Gemini, OpenCode), installs the skills into `~/.agents/skills` (with symlinks in `~/.claude/skills`), and installs the native host. It never overwrites your other config, backs each file up once as `<file>.kite-backup-<timestamp>`, skips agents you do not have, and is safe to re-run. Use `--dry-run` to see the plan, `--agents claude,codex` to pick a subset, `--yes` to skip the prompt.
3. Reload the extension (or restart Chrome), then check everything:

   ```sh
   kite doctor
   ```

   Then start a new agent session and ask it to open a page in your browser. To undo the agent side, run `kite uninstall-agents`.

## What agents can do

The MCP server exposes 15 tools:

| Tool | What it does |
| --- | --- |
| `browser_status` | whether the extension is connected, and this session's state |
| `browser_tabs`, `browser_tab_new`, `browser_tab_use`, `browser_tab_close` | list, open, select and close this session's tabs |
| `browser_goto` | navigate the active tab |
| `browser_snapshot` | read the page as a compact tree with refs |
| `browser_click`, `browser_fill`, `browser_select`, `browser_press`, `browser_scroll` | act on the page; each returns a diff of what changed |
| `browser_console`, `browser_network` | recent console messages and network requests of the tab |
| `browser_screenshot` | capture the tab |

Every action runs a safe pipeline, **FIND → CHECK → ACT → WAIT → VERIFY → REPORT**: it finds the target by name, checks that nothing covers it and that it is not disabled, acts with real input events, waits until the DOM and network are quiet, then reports what changed.

Three skills ship with it and are installed by `kite init`: `kitestring` (how to use the tools well), `kitestring-debug-frontend` (diagnose a broken UI) and `kitestring-e2e-verify` (check a change in the browser before calling it done).

## You stay in control

The popup shows the connection, the Pause switch and recent activity. The side panel is a live view of what agents are doing.

| Popup | Side panel |
| --- | --- |
| ![Popup, light](docs/ui/popup-light.png) | ![Side panel, light](docs/ui/sidepanel-light.png) |
| ![Popup, dark](docs/ui/popup-dark.png) | ![Side panel, dark](docs/ui/sidepanel-dark.png) |

Paused:

![Popup, paused](docs/ui/popup-paused-light.png)

## Safety model

- **Pause switch.** Pause from the popup, the side panel, or `kite pause` (`kite resume` to continue). An action already in flight finishes or hits its time cap; queued and new requests are refused immediately with `PAUSED`.
- **Per-session ownership.** Each agent session gets its own tab group, `kite:<session>`, and can only act on tabs it owns. Touching another session's tab fails with `NOT_OWNER`.
- **Restricted pages are refused.** `chrome://` pages, the Chrome Web Store and other pages the browser keeps from extensions answer `restricted page`.
- **One action at a time per tab.** If two agents target the same tab, the second waits rather than interleaving input.
- **Page text is data.** The skills tell agents to treat page content as untrusted data, never as instructions, and never to type passwords.
- While kite acts on a tab, Chrome shows its "started debugging this browser" bar. That is expected.

Kitestring does not yet batch actions or classify the risk of an action; those are planned.

## Troubleshooting

Run `kite doctor`. It is read-only and checks the node version, the native host manifest and wrapper, the socket, the extension connection, and each agent's MCP entry and skills, printing a fix hint for anything failing. Host logs are in `$KITE_HOME/logs/host.log` (`$KITE_HOME` defaults to `~/.kitestring`).

### Coming from the old `bx`

Run `kite install-host`. It removes the legacy `com.bx.bridge` manifest and writes `com.kitestring.bridge`. Then reload the extension. `~/.bx` is no longer used and can be deleted when you are ready (kite never deletes it for you).

### Verify with Codex (manual)

Codex's desktop app is not scripted, so check it by hand:

1. Run `kite init --agents codex` and confirm `~/.codex/config.toml` has a `[mcp_servers.kitestring]` table.
2. Fully quit and reopen the Codex desktop app so it reloads its config.
3. Start the torture site (`pnpm --filter torture dev`) and a new Codex thread, and send: `Use the kitestring tools: open http://127.0.0.1:4173/basic-form, fill Name with Ada and Email with ada@x.io, submit, then report the page's window.__result via a snapshot of the confirmation`.
4. Approve the `kitestring` tool calls if asked. Expect the reply to mention `submitted:Ada:ada@x.io`, and the activity list in the popup to show the calls.

### Agent smoke test

`scripts/agent-smoke.sh [claude|opencode] --yes` starts the torture site, has a real agent fill the form through the MCP tools, then checks that the site recorded `submitted:Ada:ada@x.io`. It refuses to run unless `kite doctor` reports the bridge and extension as ok, **spends your agent credits**, needs an explicit `--yes` (or an interactive confirm), and must never run in CI.

---

## Development

### Prerequisites

- **macOS or Linux.** Windows host install comes later.
- **Node ≥ 22.12** (commander 15 needs it). Node 26 works too; `.nvmrc` says 22.12.
- **pnpm.** Install it with `npm i -g pnpm`; corepack no longer ships with Node ≥ 25. This repo pins pnpm 12.14.0 (`packageManager` in `package.json`).
- **Google Chrome or Chromium.**

### Build from source

```sh
pnpm i
pnpm build
```

`pnpm build` builds `@kitestring/protocol`, the extension (`packages/extension/build/chrome-mv3-prod`) and the CLI (`packages/cli/dist`).

For convenience, alias the CLI:

```sh
alias kite="node $PWD/packages/cli/dist/bin.js"
```

#### Extension identity (optional)

The extension ID is fixed by the public key in `packages/extension/package.json` (`manifest.key`): `bdfegcbeenjmlbfogodoibdhfbonnicm`. That is the ID the native host allows by default (`EXTENSION_ID` in `packages/protocol/src/constants.ts`). You do **not** need the private key to load the extension unpacked.

To use your own key pair instead:

```sh
node scripts/gen-extension-key.mjs   # writes keys/bx.pem (gitignored), prints {key, id}
```

Then put `key` into `manifest.key` in `packages/extension/package.json` and `id` into `EXTENSION_ID`, and rebuild. Without `--force`, the script reuses an existing `keys/bx.pem`.

#### Load the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `packages/extension/build/chrome-mv3-prod`.
3. Check that the card shows ID `bdfegcbeenjmlbfogodoibdhfbonnicm`, or your own ID if you generated a key.

#### Install the native host and try it

```sh
kite install-host                 # Chrome; use --browser chromium for Chromium
```

This writes `com.kitestring.bridge.json` into the browser's `NativeMessagingHosts` directory and a wrapper script into `$KITE_HOME` (default `~/.kitestring`). Other options:

- `--user-data-dir <dir>` targets a custom profile directory.
- `--extension-id <id>` allows an extension ID other than the default.

Next, reload the extension (or restart Chrome) so it connects to the host:

```sh
kite status                        # {"connected": true, ...}
kite tab new https://example.com && kite snapshot
```

`kite snapshot` prints the visible page as a compact tree with refs (`@e…`). You can act on those refs or on visible text:

```sh
kite click "Learn more"            # or by ref: kite click @e1a2b3
kite fill Email ada@example.com
kite select Country India
kite press Enter
kite scroll down                   # one viewport; or: kite scroll up 400
kite goto https://example.org
```

When an action fails, it says why and the command exits 1:

- `✗ blocked: covered by dialog "Cookie banner"`
- `✗ disabled: Enter a valid email`
- `✗ ambiguous` (followed by the candidate refs)
- `✗ not_found`
- `✗ no_effect`
- `✗ timeout`

If the browser does not answer at all, the CLI gives up after 60 s (`kite: timed out waiting for the browser`, exit 1; `KITE_TIMEOUT_MS` overrides the bound). Exit code 2 means the browser is not connected, or the usage was wrong. Add `--json` to get the raw result (errors too, as `{"error":{"code","message"}}`), and `--session <name>` (or `KITE_SESSION`) to keep separate agents' tabs apart. Each session gets its own tab group, `kite:<name>`.

While kite acts on a tab, Chrome shows the "kite started debugging this browser" bar. If you cancel it, the next action attaches again.

Pages the browser does not let extensions touch, such as `chrome://` pages and the Chrome Web Store, answer `restricted page (…) — browser blocks extensions here`.

Host logs are in `$KITE_HOME/logs/host.log`.

### Tests

```sh
pnpm test        # unit tests: protocol, CLI/host, torture server, page agent (Vitest + Playwright)
pnpm typecheck
pnpm test:e2e    # page-agent fixtures + full end-to-end against the torture site
```

The end-to-end suite (`e2e/`) works like this:

- It needs `pnpm build` first.
- It runs headless and doesn't touch your Chrome profile or `~/.kitestring`.
- For each test it installs the native host into a temporary user-data-dir and starts the torture site (`apps/torture`, 12 edge-case pages; see `apps/torture/expected.md`).
- It launches **Playwright's Chromium** with the built extension, then drives everything through the real `kite` CLI.

If Playwright's Chromium is missing, install it:

```sh
pnpm --filter @kitestring/e2e exec playwright install chromium
```

To serve the torture site by hand, run `pnpm --filter torture dev` (http://127.0.0.1:4173).

### Environment notes

- **Node 26** builds and runs everything, Plasmo included.
- **pnpm 12** ignores the `pnpm.onlyBuiltDependencies` field in `package.json`. Packages that need install scripts (esbuild, @swc/core, @parcel/watcher, lmdb, msgpackr-extract, sharp) are allowed through `allowBuilds:` in `pnpm-workspace.yaml`.
- **zod is pinned to `~3.24.4`** in `@kitestring/protocol`. Plasmo's Parcel bundles zod 3.25 incorrectly (`z` is undefined), which crashes the service worker at startup.
- **e2e uses Playwright's Chromium (`channel: "chromium"`), not branded Chrome.** Branded Chrome ≥ 137 ignores `--load-extension`. With a custom `--user-data-dir`, Chromium reads native host manifests from `<user-data-dir>/NativeMessagingHosts`, so tests write nothing outside temp dirs.

### Layout

```
packages/protocol     shared types, RPC schema, constants
packages/page-agent   snapshot / find / check / quiet / diff / brief (runs in the page)
packages/extension    background: native port, RPC router, sessions, CDP pipeline; content script
packages/cli          kite CLI, native host + socket daemon, host installer
apps/torture          edge-case test site
e2e                   Playwright end-to-end suite
```
