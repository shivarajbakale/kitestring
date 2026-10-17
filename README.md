# bx

`bx` lets any AI agent (or you, from a terminal) drive your real Chrome: your profile, your logins, your tabs. It has three parts:

- **Chrome extension** (`packages/extension`, Plasmo, MV3). It reads pages through a content-script page agent and acts through `chrome.debugger` (CDP).
- **Native host + socket daemon** (`packages/cli/src/host`). Chrome starts it through native messaging, and it listens on `$BX_HOME/bx.sock`.
- **CLI** (`packages/cli`). `bx tab new`, `bx snapshot`, `bx click`, `bx fill` and so on talk to the daemon over the socket.

Every action runs a safe pipeline: **FIND → CHECK → ACT → WAIT → VERIFY → REPORT**. It finds the target by name, checks that nothing covers it and that it is not disabled, acts with real input events, waits until the DOM and the network are quiet, and then reports a diff of what changed.

## Prerequisites

- **macOS or Linux.** Windows host install comes later.
- **Node ≥ 22.12** (commander 15 needs it). Node 26 works too; `.nvmrc` says 22.12.
- **pnpm.** Install it with `npm i -g pnpm`; corepack no longer ships with Node ≥ 25. This repo pins pnpm 12.14.0 (`packageManager` in `package.json`).
- **Google Chrome or Chromium.**

## Quickstart (development)

```sh
pnpm i
pnpm build
```

`pnpm build` builds `@bx/protocol`, the extension (`packages/extension/build/chrome-mv3-prod`) and the CLI (`packages/cli/dist`).

For convenience, alias the CLI:

```sh
alias bx="node $PWD/packages/cli/dist/bin.js"
```

### Extension identity (optional)

The extension ID is fixed by the public key in `packages/extension/package.json` (`manifest.key`): `bdfegcbeenjmlbfogodoibdhfbonnicm`. That is the ID the native host allows by default (`EXTENSION_ID` in `packages/protocol/src/constants.ts`). You do **not** need the private key to load the extension unpacked.

To use your own key pair instead:

```sh
node scripts/gen-extension-key.mjs   # writes keys/bx.pem (gitignored), prints {key, id}
```

Then put `key` into `manifest.key` in `packages/extension/package.json` and `id` into `EXTENSION_ID`, and rebuild. Without `--force`, the script reuses an existing `keys/bx.pem`.

### Load the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `packages/extension/build/chrome-mv3-prod`.
3. Check that the card shows ID `bdfegcbeenjmlbfogodoibdhfbonnicm`, or your own ID if you generated a key.

### Install the native host and try it

```sh
bx install-host                 # Chrome; use --browser chromium for Chromium
```

This writes `com.bx.bridge.json` into the browser's `NativeMessagingHosts` directory and a wrapper script into `$BX_HOME` (default `~/.bx`). Other options:

- `--user-data-dir <dir>` targets a custom profile directory.
- `--extension-id <id>` allows an extension ID other than the default.

Next, reload the extension (or restart Chrome) so it connects to the host:

```sh
bx status                        # {"connected": true, ...}
bx tab new https://example.com && bx snapshot
```

`bx snapshot` prints the visible page as a compact tree with refs (`@e…`). You can act on those refs or on visible text:

```sh
bx click "Learn more"            # or by ref: bx click @e1a2b3
bx fill Email ada@example.com
bx select Country India
bx press Enter
bx scroll down                   # one viewport; or: bx scroll up 400
bx goto https://example.org
```

When an action fails, it says why and the command exits 1:

- `✗ blocked: covered by dialog "Cookie banner"`
- `✗ disabled: Enter a valid email`
- `✗ ambiguous` (followed by the candidate refs)
- `✗ not_found`
- `✗ no_effect`
- `✗ timeout`

If the browser does not answer at all, the CLI gives up after 60 s (`bx: timed out waiting for the browser`, exit 1; `BX_TIMEOUT_MS` overrides the bound). Exit code 2 means the browser is not connected, or the usage was wrong. Add `--json` to get the raw result (errors too, as `{"error":{"code","message"}}`), and `--session <name>` (or `BX_SESSION`) to keep separate agents' tabs apart. Each session gets its own tab group, `bx:<name>`.

While bx acts on a tab, Chrome shows the "bx started debugging this browser" bar. If you cancel it, the next action attaches again.

Pages the browser does not let extensions touch, such as `chrome://` pages and the Chrome Web Store, answer `restricted page (…) — browser blocks extensions here`.

Host logs are in `$BX_HOME/logs/host.log`.

## Tests

```sh
pnpm test        # unit tests: protocol, CLI/host, torture server, page agent (Vitest + Playwright)
pnpm typecheck
pnpm test:e2e    # page-agent fixtures + full end-to-end against the torture site
```

The end-to-end suite (`e2e/`) works like this:

- It needs `pnpm build` first.
- It runs headless and doesn't touch your Chrome profile or `~/.bx`.
- For each test it installs the native host into a temporary user-data-dir and starts the torture site (`apps/torture`, 12 edge-case pages; see `apps/torture/expected.md`).
- It launches **Playwright's Chromium** with the built extension, then drives everything through the real `bx` CLI.

If Playwright's Chromium is missing, install it:

```sh
pnpm --filter @bx/e2e exec playwright install chromium
```

To serve the torture site by hand, run `pnpm --filter torture dev` (http://127.0.0.1:4173).

## Environment notes

- **Node 26** builds and runs everything, Plasmo included.
- **pnpm 12** ignores the `pnpm.onlyBuiltDependencies` field in `package.json`. Packages that need install scripts (esbuild, @swc/core, @parcel/watcher, lmdb, msgpackr-extract, sharp) are allowed through `allowBuilds:` in `pnpm-workspace.yaml`.
- **zod is pinned to `~3.24.4`** in `@bx/protocol`. Plasmo's Parcel bundles zod 3.25 incorrectly (`z` is undefined), which crashes the service worker at startup.
- **e2e uses Playwright's Chromium (`channel: "chromium"`), not branded Chrome.** Branded Chrome ≥ 137 ignores `--load-extension`. With a custom `--user-data-dir`, Chromium reads native host manifests from `<user-data-dir>/NativeMessagingHosts`, so tests write nothing outside temp dirs.

## Layout

```
packages/protocol     shared types, RPC schema, constants
packages/page-agent   snapshot / find / check / quiet / diff / brief (runs in the page)
packages/extension    background: native port, RPC router, sessions, CDP pipeline; content script
packages/cli          bx CLI, native host + socket daemon, host installer
apps/torture          edge-case test site
e2e                   Playwright end-to-end suite
```
