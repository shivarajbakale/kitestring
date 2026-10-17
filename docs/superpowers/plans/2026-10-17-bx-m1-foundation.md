# bx M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working end-to-end path: `bx click "Save"` from a terminal drives the user's real Chrome through a Plasmo extension, using the safe action pipeline, verified against a local torture-test site.

**Architecture:** pnpm monorepo. `packages/protocol` (shared zod types), `packages/page-agent` (pure DOM logic: snapshot, refs, find, check, quiet, diff), `packages/cli` (`bx` binary: CLI client + native-messaging host daemon + host installer), `packages/extension` (Plasmo MV3: background pipeline + CDP + sessions, content script wrapping page-agent), `apps/torture` (edge-case test site), `e2e/` (Playwright, real Chromium + real extension + real CLI).

**Tech Stack:** Node ≥ 22, pnpm 9+, TypeScript 5, Plasmo 0.x, zod 3, dom-accessibility-api, commander, Vitest, Playwright Test, esbuild.

**Spec:** `docs/superpowers/specs/2026-10-17-bx-design.md`

## Global Constraints

- Node ≥ 22. If `plasmo build` fails on the installed Node (26), pin Node 22 LTS via `.nvmrc` and document it in README.
- pnpm workspaces. Install pnpm with `npm i -g pnpm` (corepack is not bundled with Node ≥ 25).
- Native host name `com.bx.bridge`. Socket `$BX_HOME/bx.sock`, mode 0600. `BX_HOME` default `~/.bx`.
- Host stdout carries only native-messaging frames (4-byte little-endian length + UTF-8 JSON). All logs go to `$BX_HOME/logs/host.log`.
- Host → Chrome message ≤ 1 MB; host must reject larger outgoing frames with an error, never send them.
- Ref format: `@e` + exactly 5 lowercase base36 chars (regex `^@e[0-9a-z]{5}$`).
- Ready = DOM quiet 300 ms (ignore `style` attribute mutations) AND no visible `[aria-busy="true"]`/`[role="progressbar"]` AND network quiet 300 ms (ignore resource types `WebSocket`, `EventSource`, `Ping`; ignore hosts matching `google-analytics|googletagmanager|doubleclick|segment|hotjar|mixpanel|sentry|datadoghq`). Max 10 000 ms.
- FIND scores: exact name 100, exact label 95, exact placeholder 90, starts-with 70, contains 50, token overlap ≥ 0.6 → 30; +5 visible, +3 in viewport. Ambiguous when top two differ by ≤ 5 and both ≥ 50. Not-found retries: scroll one viewport, max 3.
- Extension permissions: `debugger`, `tabs`, `tabGroups`, `scripting`, `nativeMessaging`, `storage`; host permissions `<all_urls>`. (`sidePanel` arrives in M2.)
- M1 operates on the top frame only.
- Commit messages: conventional commits (`feat:`, `test:`, `chore:`).

## Review Focus

1. **Stale socket after host crash** — a leftover `bx.sock` with no listener must not block the next host start; host unlinks it when `connect` fails with `ECONNREFUSED`. Test in Task 2.
2. **Click that navigates** — the content script dies mid-action; result must be `done` with `navigation.url`, never `"Receiving end does not exist"`. Test in Task 9 (`navigating-link` page).
3. **Odd whitespace/case in targets** — `"  save changes "` must match button `Save changes`. Test in Task 6.
4. **Restricted pages** (`chrome://`, Chrome Web Store) — commands return `status: "restricted"` with a clear message instead of hanging. Test in Task 8.
5. **Browser not running / extension not connected** — CLI exits code 2 with `bx: browser not connected (is Chrome open with the bx extension?)` within 2 s. Test in Task 3.

---

## File Structure

```
bx/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  .gitignore  .nvmrc  README.md
  packages/protocol/src/{constants.ts, target.ts, rpc.ts, results.ts, index.ts}
  packages/protocol/test/protocol.test.ts
  packages/page-agent/src/{normalize.ts, roles.ts, refs.ts, snapshot.ts, find.ts, check.ts, quiet.ts, diff.ts, brief.ts, index.ts}
  packages/page-agent/tests/{fixtures/*.html, harness.ts, *.spec.ts}  playwright.config.ts
  packages/cli/src/host/{framing.ts, daemon.ts, main.ts}
  packages/cli/src/client/{rpc-client.ts, format.ts}
  packages/cli/src/install/{host-manifest.ts}
  packages/cli/src/{bin.ts, commands.ts, paths.ts}
  packages/cli/test/{framing.test.ts, daemon.test.ts, cli.test.ts, host-manifest.test.ts}
  packages/extension/  (Plasmo app)
    package.json (manifest overrides + key)
    background/{index.ts, native-port.ts, rpc-router.ts, sessions.ts, agent-bridge.ts, cdp.ts, network-idle.ts, pipeline.ts, input.ts}
    contents/agent.ts
  apps/torture/{server.ts, pages/*.html, expected.md}
  e2e/{playwright.config.ts, fixtures.ts, m1.spec.ts}
  scripts/{gen-extension-key.mjs}
```

---

### Task 1: Monorepo scaffold + protocol package

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.nvmrc`
- Create: `packages/protocol/{package.json,tsconfig.json}`, `packages/protocol/src/{constants.ts,target.ts,rpc.ts,results.ts,index.ts}`
- Test: `packages/protocol/test/protocol.test.ts`

**Interfaces:**
- Produces:
  - `constants.ts`: `HOST_NAME = "com.bx.bridge"`, `REF_RE = /^@e[0-9a-z]{5}$/`, `MAX_HOST_TO_CHROME = 1024*1024`, `READY = { quietMs: 300, timeoutMs: 10000 }`, `ANALYTICS_HOST_RE`, `IGNORED_RESOURCE_TYPES = ["WebSocket","EventSource","Ping"]`
  - `target.ts`: `type Target = { ref: string } | { text: string; within?: string; role?: string }`; `parseTarget(input: string, opts?: { within?: string; role?: string }): Target`
  - `rpc.ts`: zod `RpcRequest {id: number, method: Method, params: object, session: string}`, `RpcResponse {id, result?} | {id, error: {code: string, message: string}}`; `type Method = "status"|"tab.new"|"tab.list"|"tab.close"|"tab.use"|"page.goto"|"page.snapshot"|"act.click"|"act.fill"|"act.press"|"act.select"|"act.scroll"`
  - `results.ts`: `type Status = "done"|"not_found"|"ambiguous"|"blocked"|"disabled"|"no_effect"|"timeout"|"restricted"|"error"`; `interface Diff { added: string[]; removed: string[] }`; `interface Candidate { ref: string; line: string; score: number }`; `interface ActionResult { ok: boolean; status: Status; detail?: string; diff: Diff; navigation?: { url: string; title: string }; newTabs?: number[]; errors?: string[]; candidates?: Candidate[]; blockedBy?: string; page: string }`
  - Error codes (string): `NOT_CONNECTED`, `NO_TAB`, `NOT_OWNER`, `RESTRICTED`, `BAD_REQUEST`, `INTERNAL`

- [ ] **Step 1:** Install pnpm (`npm i -g pnpm`), write root `package.json` (`private`, scripts `build`, `test`, `test:e2e`, `typecheck` running `pnpm -r`), `pnpm-workspace.yaml` (`packages/*`, `apps/*`, `e2e`), `tsconfig.base.json` (strict, ES2022, moduleResolution bundler), `.gitignore` (`node_modules`, `build`, `dist`, `.plasmo`, `keys/`, `test-results`), `.nvmrc` = `22`.
- [ ] **Step 2: Write failing tests** in `protocol.test.ts`:
  ```ts
  expect(parseTarget("@e1k2d9")).toEqual({ ref: "@e1k2d9" })
  expect(parseTarget("Save", { within: "Profile" })).toEqual({ text: "Save", within: "Profile" })
  expect(parseTarget("@notaref")).toEqual({ text: "@notaref" })
  expect(RpcRequest.safeParse({ id: 1, method: "act.click", params: {}, session: "default" }).success).toBe(true)
  expect(RpcRequest.safeParse({ id: 1, method: "nope", params: {}, session: "x" }).success).toBe(false)
  ```
- [ ] **Step 3:** Run `pnpm --filter @bx/protocol test` → FAIL (module missing).
- [ ] **Step 4:** Implement the produced interfaces.
- [ ] **Step 5:** Run tests → PASS. Run `pnpm -r typecheck` → no errors.
- [ ] **Step 6:** Commit `chore: scaffold monorepo and protocol package`.

---

### Task 2: Native-messaging framing + host daemon

**Files:**
- Create: `packages/cli/{package.json,tsconfig.json}`, `packages/cli/src/paths.ts`, `packages/cli/src/host/{framing.ts,daemon.ts,main.ts}`
- Test: `packages/cli/test/{framing.test.ts,daemon.test.ts}`

**Interfaces:**
- Consumes: `RpcRequest`, `RpcResponse`, `MAX_HOST_TO_CHROME` from `@bx/protocol`
- Produces:
  - `paths.ts`: `bxHome(): string` (env `BX_HOME` or `~/.bx`), `socketPath(): string`, `logPath(): string`
  - `framing.ts`: `encodeFrame(msg: unknown): Buffer` (throws `FrameTooLargeError` when > `MAX_HOST_TO_CHROME`); `class FrameDecoder { push(chunk: Buffer): unknown[] }` (handles split and concatenated frames)
  - `daemon.ts`: `startDaemon(opts: { socketPath: string; toExtension: (msg: unknown) => void }): Promise<Daemon>`; `interface Daemon { fromExtension(msg: unknown): void; close(): Promise<void> }`. Wire protocol on socket: newline-delimited JSON `RpcRequest`/`RpcResponse`. Daemon rewrites request `id` to a daemon-unique id when forwarding to extension and maps responses back to the originating socket + original id. If the extension disconnects, pending requests get error `NOT_CONNECTED`.
  - `main.ts`: entry Chrome spawns: decodes stdin frames → `daemon.fromExtension`; `toExtension` writes `encodeFrame` to stdout; exits when stdin ends; logs to `logPath()`.

- [ ] **Step 1: Failing framing tests:** round-trip `{a:1}`; decoder given frame split at every byte offset yields one message; two frames in one chunk yield two messages; `encodeFrame` of a 1.1 MB string throws `FrameTooLargeError`.
- [ ] **Step 2:** Run `pnpm --filter @bx/cli test framing` → FAIL.
- [ ] **Step 3:** Implement `framing.ts` (`readUInt32LE`/`writeUInt32LE`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Failing daemon tests** (temp dir socket, fake `toExtension` collecting messages):
  - `routes request to extension and response back to the right client`: two clients send `id: 1` each; fake extension replies out of order; each client receives its own result with `id: 1`.
  - `fails pending requests with NOT_CONNECTED when extension disconnects`: call `daemon.fromExtension({ type: "disconnected" })` → client gets `error.code === "NOT_CONNECTED"`.
  - `socket file has mode 0600`.
  - `unlinks stale socket`: create a plain file at socket path (no listener) → `startDaemon` succeeds. (Review Focus 1)
  - `refuses to start when a live daemon owns the socket`: second `startDaemon` rejects with message containing `already running`.
- [ ] **Step 6:** Run → FAIL.
- [ ] **Step 7:** Implement `daemon.ts` (`net.createServer`, `fs.chmod`; stale check via test `net.connect` → `ECONNREFUSED`/`ENOENT` ⇒ unlink) and `main.ts`.
- [ ] **Step 8:** Run → PASS.
- [ ] **Step 9:** Commit `feat(host): native messaging framing and socket daemon`.

---

### Task 3: CLI client, commands, host installer

**Files:**
- Create: `packages/cli/src/client/{rpc-client.ts,format.ts}`, `packages/cli/src/{commands.ts,bin.ts}`, `packages/cli/src/install/host-manifest.ts`
- Test: `packages/cli/test/{cli.test.ts,host-manifest.test.ts}`

**Interfaces:**
- Consumes: `startDaemon` (tests use it with a fake extension), `parseTarget`, `ActionResult`
- Produces:
  - `rpc-client.ts`: `call(method: Method, params: object, opts: { session: string; timeoutMs?: number }): Promise<unknown>`; connect timeout 2000 ms → throws `BxError("NOT_CONNECTED")`.
  - `format.ts`: `formatResult(r: ActionResult): string` — first line `✓ <status>` or `✗ <status>: <detail>`, then `+ line` per added, `- line` per removed, `→ navigated <url>` if navigation, `candidates:` block if any, then `page: <page>`.
  - CLI surface (commander), global flags `--session <name>` (default env `BX_SESSION` or `default`), `--json`:
    `bx status` · `bx tab new [url]` · `bx tab list` · `bx tab use <id>` · `bx tab close [id]` · `bx goto <url>` · `bx snapshot [--full] [--scope <ref>]` · `bx click <target> [--within <name>] [--role <role>]` · `bx fill <target> <text> [--within] ` · `bx press <key>` · `bx select <target> <value>` · `bx scroll <up|down> [px]` · `bx install-host [--browser chrome|chromium] [--user-data-dir <dir>] [--extension-id <id>]`
  - Exit codes: 0 ok, 1 action status not `done`, 2 not connected / usage error.
  - `host-manifest.ts`: `installHost(opts: { browser: "chrome"|"chromium"; userDataDir?: string; extensionId: string; bxHome: string }): { manifestPath: string; wrapperPath: string }`. Writes `$BX_HOME/host.sh` (`#!/bin/sh\nexec "<process.execPath>" "<abs path to dist/host/main.js>"`, chmod 755) and manifest JSON `{ name: HOST_NAME, description, path: wrapperPath, type: "stdio", allowed_origins: ["chrome-extension://<id>/"] }` to:
    - `userDataDir` given → `<userDataDir>/NativeMessagingHosts/com.bx.bridge.json`
    - macOS chrome → `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`; chromium → `~/Library/Application Support/Chromium/NativeMessagingHosts/`
    - Linux chrome → `~/.config/google-chrome/NativeMessagingHosts/`; chromium → `~/.config/chromium/NativeMessagingHosts/`
    - Wrapper `host.sh` also exports `BX_HOME` so the Chrome-spawned host uses the same home as the CLI.
- [ ] **Step 1: Failing tests** in `cli.test.ts` (spawn built `bin.js` with `BX_HOME` = temp dir, in-process daemon + fake extension that answers `act.click` with a canned `ActionResult`):
  - `bx click Save` prints line starting `✓ done` and exits 0; fake extension received `params.target` `{ text: "Save" }` and `session: "default"`.
  - `BX_SESSION=agent2 bx click @e1k2d9` → request `session: "agent2"`, target `{ ref: "@e1k2d9" }`.
  - `--json` prints parseable JSON equal to the canned result.
  - Canned `not_found` result → exit code 1.
  - No daemon running → stderr exactly `bx: browser not connected (is Chrome open with the bx extension?)`, exit 2, finishes < 2500 ms. (Review Focus 5)
- [ ] **Step 2:** Failing `host-manifest.test.ts`: with `userDataDir` temp → manifest written at expected path, `allowed_origins` correct, wrapper executable and contains `BX_HOME=`.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement. Build with `tsc` to `dist/`; `package.json` `bin: { bx: "dist/bin.js" }`.
- [ ] **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit `feat(cli): bx commands, rpc client, host installer`.

---

### Task 4: Torture site (M1 pages)

**Files:**
- Create: `apps/torture/{package.json,server.ts,expected.md}`, `apps/torture/pages/*.html`

**Interfaces:**
- Produces: `startTorture(port = 4173): Promise<{ url: string; close(): Promise<void> }>` serving `pages/<name>.html` at `/<name>`. Every page sets `window.__result` (string) when its task is completed correctly, and `window.__result = "WRONG:<why>"` on a wrong action. `expected.md` lists each page's task (the CLI command sequence) and expected `__result`.

Pages (each: task → expected `__result`):
| Page | Content | Task | `__result` |
|---|---|---|---|
| `basic-form` | Name, Email inputs (labels), Submit | fill Name, Email; click Submit | `submitted:Ada:ada@x.io` |
| `duplicate-buttons` | sections "Profile" and "Billing", each with "Save" | click Save within Profile | `saved:profile` (Billing → `WRONG`) |
| `icon-only` | `<button aria-label="Delete item">🗑</button>`, `<button title="Settings">⚙</button>` | click "Delete item" | `deleted` |
| `covered-by-banner` | fixed cookie banner covering "Continue" until "Accept" clicked | click Continue → expect `blocked`; click Accept; click Continue | `continued` |
| `infinite-scroll` | list loads 20 more items on scroll; "Item 57" button appears after 2 loads | click "Item 57" | `item:57` |
| `slow-button` | "Load data" → spinner `role=progressbar` for 1500 ms → text "Data ready" | click Load data; result diff contains `Data ready` | `loaded` |
| `never-idle` | `setInterval` 100 ms updating `style` of a decorative div + WebSocket-free `fetch` to `/analytics/google-analytics` every 200 ms; button "Go" | click Go returns within 3000 ms with `done` | `go` |
| `disabled-until-valid` | Submit disabled until email valid; `role=alert` message "Enter a valid email" | click Submit → `disabled` with errors containing that message; fill valid; click Submit | `ok` |
| `rerender` | React-like full re-render of a list every 500 ms (same content, new nodes); button "Pick me" | snapshot, wait 1 s, click by the ref from snapshot | `picked` |
| `native-select` | `<select>` labeled "Country" | select Country "India" | `country:IN` |
| `navigating-link` | link "Next page" → `/navigating-link-done` which sets `__result` | click Next page → `done` with `navigation.url` ending `/navigating-link-done` | `arrived` |
| `whitespace` | button text `Save changes` | click `"  save changes "` | `saved` |

- [ ] **Step 1:** Write `server.ts` (node `http`, static, plus `/analytics/*` returning 204) and the pages above. Pages use plain inline JS, no frameworks.
- [ ] **Step 2:** Manually verify: `pnpm --filter torture dev` and open each page; complete each task by hand in Chrome; check `window.__result` in DevTools.
- [ ] **Step 3:** Commit `test(torture): M1 edge-case pages`.

---

### Task 5: Page agent — roles, refs, snapshot

**Files:**
- Create: `packages/page-agent/{package.json,tsconfig.json,playwright.config.ts}`, `src/{normalize.ts,roles.ts,refs.ts,snapshot.ts,index.ts}`
- Test: `tests/harness.ts`, `tests/snapshot.spec.ts`, `tests/fixtures/{snapshot.html,rerender.html}`

**Interfaces:**
- Consumes: `REF_RE`
- Produces:
  - `normalize.ts`: `norm(s: string): string` (NFKC, ` `→space, collapse whitespace, trim, lowercase)
  - `roles.ts`: `roleOf(el: Element): string | null` and `nameOf(el: Element): string` via `dom-accessibility-api` (`getRole`, `computeAccessibleName`); `INTERACTIVE_ROLES: Set<string>` = button, link, textbox, searchbox, checkbox, radio, combobox, listbox, option, menuitem, tab, switch, slider, spinbutton; `LANDMARK_ROLES` = main, navigation, banner, contentinfo, complementary, form, region, dialog, alertdialog, list (for collapse), heading (content).
  - `refs.ts`: `class RefRegistry { refFor(el: Element): string; resolve(ref: string): Element | null }` — ref = `"@e" + base36(fnv1a(role|name|landmarkPath|occurrence)).padStart(5,"0").slice(-5)`; collision → increment occurrence. `resolve` re-scans document if cached element is disconnected (that is how refs survive re-render).
  - `snapshot.ts`: `snapshot(doc: Document, reg: RefRegistry, opts: { full?: boolean; scope?: string; maxLines?: number }): string` — format per spec §4; viewport-only unless `full`; lists with > 5 items collapsed to `item[0..2] … +N`; header line `page "<title>" <url>`; `value="…"`, `disabled`, `checked`, `expanded` annotations; hidden elements (`display:none`, `visibility:hidden`, `aria-hidden`, zero size) omitted.
  - `index.ts`: `createAgent(win: Window): PageAgent` with `snapshot(opts)`; later tasks add methods.
  - `tests/harness.ts`: Playwright fixture that esbuild-bundles `src/index.ts` as IIFE `window.__bxAgent = createAgent(window)` and injects it into a page loaded from `fixtures/*.html`.
- [ ] **Step 1: Failing tests** (`snapshot.spec.ts`):
  - snapshot of `snapshot.html` contains `textbox "Email" [@e` and `button "Continue" [@e` and `disabled` on the disabled button; does not contain hidden button text `Secret`.
  - every ref matches `REF_RE`.
  - a 50-item list yields `(50 items)` and `+47`.
  - element below the fold absent by default, present with `{ full: true }`.
  - `rerender.html`: ref of "Pick me" before and after 3 re-renders is identical, and `resolve(ref)` returns the new connected node.
- [ ] **Step 2:** Run `pnpm --filter @bx/page-agent test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(page-agent): stable refs and compact snapshot`.

---

### Task 6: Page agent — find

**Files:**
- Create: `packages/page-agent/src/find.ts`; modify `src/index.ts`
- Test: `tests/find.spec.ts`, `tests/fixtures/find.html`

**Interfaces:**
- Consumes: `norm`, `roleOf`, `nameOf`, `RefRegistry`, `Target`
- Produces: `find(doc, reg, target: Target, intent: "click"|"fill"|"select"): FindResult` where `type FindResult = { kind: "found"; ref: string; line: string } | { kind: "ambiguous"; candidates: Candidate[] } | { kind: "not_found" }`. Intent filters roles: `fill` → textbox/searchbox/combobox/contenteditable; `select` → combobox/listbox; `click` → any interactive role. Label match uses `<label for>`, wrapping label, `aria-labelledby`. `within` restricts to the subtree of the nearest landmark/region/section whose accessible name or first heading normalizes equal to `within`. Scoring per Global Constraints. `PageAgent.find(target, intent)` exposed.
- [ ] **Step 1: Failing tests:**
  - exact name beats contains: buttons "Save" and "Save draft" → finds "Save".
  - two "Save" buttons → `ambiguous`, 2 candidates; with `within: "Profile"` → found the Profile one.
  - `"  save changes "` finds `Save changes`. (Review Focus 3)
  - fill "Email" finds the input labeled Email (not the "Email us" link).
  - icon-only button by `aria-label` "Delete item" and by `title` "Settings".
  - ref target returns the same element as `resolve`.
  - "Nonexistent" → `not_found`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(page-agent): ranked target resolution`.

---

### Task 7: Page agent — check, quiet, diff, brief

**Files:**
- Create: `src/{check.ts,quiet.ts,diff.ts,brief.ts}`; modify `src/index.ts`
- Test: `tests/check.spec.ts`, `tests/quiet.spec.ts`, `tests/diff.test.ts` (Vitest, pure), fixtures `check.html`, `quiet.html`

**Interfaces:**
- Produces:
  - `check(el: Element): CheckResult` = `{ kind: "ok"; x: number; y: number } | { kind: "blocked"; by: string } | { kind: "disabled"; errors: string[] } | { kind: "hidden" }`. Scrolls into view (`block: "center"`), centre point in top-frame CSS px. `by` = `role "name"` of the covering element's nearest element with a role, else its tag. `errors` = text of visible `[role=alert]`, `[aria-live]`, and elements referenced by `aria-errormessage`/`aria-describedby` of `[aria-invalid=true]` fields in the same form.
  - `waitQuiet(win: Window, opts = READY): Promise<{ quiet: boolean; waitedMs: number }>` — MutationObserver (ignore `attributeName === "style"`), plus spinner visibility check.
  - `diffSnapshots(before: string, after: string): Diff` — line-set difference ignoring the header line and indentation; exported from package root for use in the background.
  - `brief(doc): string` — `"<title> | <url> | <first h1> | <n> interactive"`.
  - `PageAgent`: `check(ref)`, `waitQuiet()`, `brief()`, `readValue(ref): string | null`, `setSelect(ref, value): boolean` (matches option by value or normalized label; dispatches `input` + `change`).
- [ ] **Step 1: Failing tests:** button under a fixed banner → `blocked` with `by` containing `"Accept"`'s parent dialog/banner description; disabled submit → `disabled` with error "Enter a valid email"; `display:none` → `hidden`; `waitQuiet` on a page mutating `style` every 50 ms resolves `quiet: true` in < 1000 ms; on a page adding nodes every 100 ms for 2 s resolves `quiet: true` with `waitedMs ≥ 2000`; visible `role=progressbar` keeps it waiting until removed; `diffSnapshots` returns added/removed lines and ignores header changes.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(page-agent): check, quiet, diff, brief`.

---

### Task 8: Plasmo extension — native port, RPC router, sessions, e2e harness

**Files:**
- Create: `packages/extension/` via `pnpm create plasmo --with-src=false` then trim; `package.json` manifest overrides; `scripts/gen-extension-key.mjs`
- Create: `background/{index.ts,native-port.ts,rpc-router.ts,sessions.ts,agent-bridge.ts}`, `contents/agent.ts`
- Create: `e2e/{package.json,playwright.config.ts,fixtures.ts,m1.spec.ts}`

**Interfaces:**
- Consumes: `RpcRequest`, `RpcResponse`, `HOST_NAME`, `createAgent`
- Produces:
  - `scripts/gen-extension-key.mjs`: writes `keys/bx.pem` (gitignored), prints `{ key: <base64 SPKI DER>, id: <32 chars a–p from sha256(DER)> }`; key goes into `packages/extension/package.json` `manifest.key`; id into `packages/protocol/src/constants.ts` as `EXTENSION_ID`.
  - `native-port.ts`: `connectHost(onMessage: (m) => void): { send(m): void }` — `chrome.runtime.connectNative(HOST_NAME)`; on disconnect retry with backoff 1 s, 2 s, 5 s, then every 10 s. Open port keeps the service worker alive.
  - `rpc-router.ts`: `route(req: RpcRequest): Promise<RpcResponse>`; handler map keyed by `Method`; unknown → `BAD_REQUEST`; `RestrictedPageError` → `RESTRICTED` (CLI prints `bx: restricted page (<url>) — browser blocks extensions here`, exit 1); other thrown errors → `INTERNAL` with message.
  - `sessions.ts`: `getOrCreateSession(name): Session`; `interface Session { name: string; groupId: number | null; activeTabId: number | null; tabs: Set<number> }`; `newTab(s, url?)` creates tab, adds to group titled `bx:<name>` (create group on first tab, color cycles per session); `assertOwner(s, tabId)` throws `NOT_OWNER`; `useTab`, `closeTab`, `listTabs`; state persisted to `chrome.storage.session` and reloaded on service-worker start.
  - `agent-bridge.ts`: `callAgent<T>(tabId, method: keyof PageAgent, args: unknown[]): Promise<T>` — `chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })`; on "Receiving end does not exist" → inject `chrome.runtime.getManifest().content_scripts[0].js` with `chrome.scripting.executeScript`, retry once; injection failure on `chrome://`, `chrome-extension://`, `https://chrome.google.com/webstore`, `https://chromewebstore.google.com` → throw `RestrictedPageError`.
  - `contents/agent.ts`: `export const config: PlasmoCSConfig = { matches: ["<all_urls>"], run_at: "document_idle" }`; creates one `createAgent(window)` and answers `{ bx: true, method, args }` messages.
  - Handlers in this task: `status` → `{ connected: true, sessions: string[] }`, `tab.new|list|use|close`.
  - `e2e/fixtures.ts`: builds nothing (expects `pnpm build` done); creates temp `userDataDir` and temp `BX_HOME`; runs `bx install-host --browser chromium --user-data-dir <dir> --extension-id <EXTENSION_ID>`; starts torture site; `chromium.launchPersistentContext(userDataDir, { channel: "chromium", args: ["--disable-extensions-except=<build>", "--load-extension=<build>"], env: { ...process.env, BX_HOME } })`; waits until `bx status` exits 0 (≤ 10 s); exposes `bx(...args): Promise<{ code, stdout, stderr }>` and `result(page): Promise<string>` reading `window.__result` from the session tab.
- [ ] **Step 1:** Scaffold Plasmo, set manifest overrides (permissions per Global Constraints, `host_permissions: ["<all_urls>"]`, `key`). Run `pnpm --filter extension build`. If the build fails on Node 26, switch to Node 22 (`.nvmrc`) and note it in README. Expected: `build/chrome-mv3-prod/manifest.json` exists and contains `"key"`.
- [ ] **Step 2: Verify native host discovery inside a custom user-data-dir.** Write a throwaway e2e test that only checks `bx status` connects. Expected PASS. If Chromium does not read `<userDataDir>/NativeMessagingHosts`, fall back to the per-user Chromium location from Task 3 and record that in `e2e/fixtures.ts`.
- [ ] **Step 3: Failing e2e tests** (`m1.spec.ts`, describe "sessions"):
  - `bx tab new <torture>/basic-form` exits 0; `bx tab list` shows one tab with that URL; Chrome has a tab group titled `bx:default`.
  - `BX_SESSION=other bx tab close <id-of-default-tab>` → exit 1/2 with `NOT_OWNER`.
  - `bx tab new chrome://settings` then `bx snapshot` → stdout contains `restricted`, returns within 3 s. (Review Focus 4)
- [ ] **Step 4:** Run `pnpm test:e2e` → FAIL.
- [ ] **Step 5:** Implement background modules and content script (snapshot handler `page.snapshot` included so the restricted test is meaningful).
- [ ] **Step 6:** Run → PASS.
- [ ] **Step 7:** Commit `feat(extension): native bridge, sessions, page agent content script`.

---

### Task 9: Action pipeline via CDP

**Files:**
- Create: `background/{cdp.ts,network-idle.ts,input.ts,pipeline.ts}`; modify `background/rpc-router.ts`
- Modify: `e2e/m1.spec.ts`; create `README.md`

**Interfaces:**
- Consumes: `callAgent`, `Session`, `diffSnapshots`, `ActionResult`, `READY`, `ANALYTICS_HOST_RE`, `IGNORED_RESOURCE_TYPES`
- Produces:
  - `cdp.ts`: `ensureAttached(tabId): Promise<void>` (`chrome.debugger.attach({tabId}, "1.3")`, enable `Page`, `Network`, `Runtime`; idempotent); `send<T>(tabId, method, params?): Promise<T>`; `onEvent(tabId, handler): () => void`; detach on tab close.
  - `network-idle.ts`: `trackNetwork(tabId): { waitIdle(quietMs, timeoutMs): Promise<boolean> }` — counts in-flight from `Network.requestWillBeSent` minus `loadingFinished`/`loadingFailed`, skipping ignored types/hosts.
  - `input.ts`: `click(tabId, x, y)`, `insertText(tabId, text)`, `selectAll(tabId)` (Meta+A on macOS, Control+A otherwise), `press(tabId, key)` with key map for `Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, PageDown, PageUp, Space`; unknown key → `BAD_REQUEST`; `wheel(tabId, dy)`.
  - `pipeline.ts`: `runAction(session, action: { kind: "click"|"fill"|"select"; target: Target; value?: string } | { kind: "press"; key: string } | { kind: "scroll"; dy: number }): Promise<ActionResult>` and `goto(session, url): Promise<ActionResult>`. Algorithm per spec §5:
    1. `before = snapshot`; record URL; listen `Page.frameNavigated` (main frame) and `chrome.tabs.onCreated` with `openerTabId === tabId`.
    2. FIND via `callAgent("find")`; on `not_found` → `wheel` one viewport + `waitQuiet`, retry ≤ 3; still missing → `not_found`. `ambiguous` → return candidates.
    3. CHECK → `blocked` / `disabled` / `hidden` returned as statuses (`hidden` → `not_found` with detail `element hidden`).
    4. ACT via `input.ts` (`select` uses `callAgent("setSelect")`).
    5. WAIT: `Promise.all([networkIdle, agentQuiet])` capped at 10 000 ms; if navigation occurred, wait for `Page.loadEventFired` then re-ensure agent before `waitQuiet`. Cap hit → status `timeout` (still with diff/page).
    6. VERIFY: `after = snapshot`; `diff = diffSnapshots`; click with empty diff, same URL, no new tab → `no_effect`; fill → `readValue` ≠ value → `error` "value mismatch".
    7. REPORT: `page = brief()`; `newTabs` adopted into the session group.
  - Router handlers: `page.goto`, `page.snapshot`, `act.click|fill|press|select|scroll`, each acting on the session's active tab (`NO_TAB` if none).
- [ ] **Step 1: Failing e2e tests** — one test per torture page in Task 4's table, each running that page's CLI sequence and asserting both the CLI status line and `window.__result`. Specifically assert: `covered-by-banner` first click → exit 1 and stdout contains `blocked`; `disabled-until-valid` first click → `disabled` + `Enter a valid email`; `slow-button` stdout contains `+ ` line with `Data ready`; `never-idle` command duration < 3000 ms; `navigating-link` stdout contains `→ navigated` and `/navigating-link-done` (Review Focus 2); `whitespace` uses the nbsp target (Review Focus 3).
- [ ] **Step 2:** Run `pnpm build && pnpm test:e2e` → FAIL.
- [ ] **Step 3:** Implement `cdp.ts`, `network-idle.ts`, `input.ts`, `pipeline.ts`, router handlers.
- [ ] **Step 4:** Run → all M1 e2e PASS. Run full `pnpm test` → PASS.
- [ ] **Step 5:** Write `README.md` dev quickstart: prerequisites, `pnpm i && pnpm build`, `node scripts/gen-extension-key.mjs`, load unpacked `packages/extension/build/chrome-mv3-prod`, `bx install-host`, `bx tab new https://example.com && bx snapshot`, running tests. Follow it from a clean clone; every command must succeed.
- [ ] **Step 6:** Commit `feat(extension): safe action pipeline over CDP`.

---

## Later milestones

M2–M6 get their own plans (same format), written when the previous milestone's exit test passes. Scope and exit tests: spec §13.
