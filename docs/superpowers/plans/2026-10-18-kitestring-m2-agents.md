# Kitestring M2 — Agents + Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any coding agent (Claude Code, Codex, Cursor, Gemini CLI, OpenCode) can drive the user's Chrome through Kitestring after one `kite init`, and the human can watch and stop it from a branded popup and live side panel.

**Architecture:** Rename `bx` → Kitestring across the monorepo. Extension gains debug capture (console/network/screenshot), per-tab action serialization, an activity log and a pause switch; these feed a React popup and side panel. The CLI gains debug commands, an MCP stdio server (`kite mcp`) mirroring the CLI, `kite init` (agent detection, MCP registration, skills install, host install) and `kite doctor`. Skills ship as Agent Skills folders.

**Tech Stack:** As M1, plus `@modelcontextprotocol/sdk` 1.32.x (CLI package only), `jsonc-parser` (comment-preserving JSON edits), React 18 (Plasmo popup/side panel).

**Spec:** `docs/superpowers/specs/2026-10-17-bx-design.md` (name + M2 scope amended 2026-10-18). Research: `docs/superpowers/research/2026-10-18-agent-integration.md`. Prior follow-ups: `docs/superpowers/m1-followups.md`.

## Global Constraints

- Names: product **Kitestring**; CLI binary `kite` (also `kitestring`); packages `@kitestring/protocol|cli|page-agent|extension|e2e`, app `torture`; native host `com.kitestring.bridge`; home `$KITE_HOME` default `~/.kitestring`; socket `$KITE_HOME/kite.sock` (0600); session env `KITE_SESSION`; tab group title `kite:<session>`; MCP server name `kitestring`.
- Extension ID stays `bdfegcbeenjmlbfogodoibdhfbonnicm` (same key).
- Zod: `@kitestring/protocol` and the extension stay on `zod ~3.24.4` (Plasmo bundling breaks 3.25, Ruling R12). `@kitestring/cli` adds its own `zod ^3.25` dependency for the MCP SDK; MCP tool schemas use the CLI's zod only.
- MCP SDK: `@modelcontextprotocol/sdk@^1.32` (v1 API: `McpServer`, `StdioServerTransport`, `registerTool(name, {description, inputSchema: <zod shape>}, handler)`). In `kite mcp`, stdout carries only MCP protocol; logs go to stderr.
- Skills: real files in `~/.agents/skills/<name>/`; `~/.claude/skills/<name>` is a symlink to it; nowhere else. Skill `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and equals its folder; frontmatter has exactly `name` and `description` (≤ 1024 chars).
- Config edits: never clobber. JSON/JSONC via `jsonc-parser` `modify`/`applyEdits` (preserves comments/format); TOML by replacing or appending only the `[mcp_servers.kitestring]` table (+ its `.env` subtable) as text. Write atomically (temp file + rename). Back up each file once per run to `<file>.kite-backup-<YYYYMMDDHHmmss>` before the first change. `--dry-run` prints planned changes and writes nothing.
- Agent MCP entries all run `<node> <abs path>/packages/cli/dist/bin.js mcp` with env `KITE_SESSION=<agent>` (`claude-code`, `codex`, `cursor`, `gemini`, `opencode`). Timeouts: Codex `startup_timeout_sec = 20`, `tool_timeout_sec = 60`; OpenCode `timeout: 15000`; Gemini `timeout: 60000`.
- Node path in generated wrappers/configs: first existing of `process.execPath` if it does not contain `/Cellar/`, then `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `process.execPath`. The host wrapper re-checks the same candidate list at runtime (`for n in …; do [ -x "$n" ] && exec "$n" …; done`).
- UI: React in Plasmo `popup.tsx` and `sidepanel.tsx`; design via the `impeccable` skill; brand assets via the `logo-design` skill. Both themes (light/dark via `prefers-color-scheme`). Popup width 360 px. No external network requests from UI (fonts/assets bundled).
- Extension permissions after M2: M1 set + `sidePanel`. Nothing else.
- Activity log: `chrome.storage.session` key `activity`, ring of 200 entries `{id, ts, session, tabId, method, target?, status, ms, url?, summary}`.
- Debug capture ring buffers per tab: console 500 entries, network 500 entries; capture starts when the debugger attaches, which now happens on `tab.new`/`tab.use`/`page.goto` (not lazily on first action).
- Commit messages: conventional commits; trailer lines as in M1.

## Review Focus

1. **Existing `bx` install on the user's machine** (`com.bx.bridge.json` manifest, `~/.bx`) — `kite install-host` removes the legacy manifest and prints that `~/.bx` can be deleted; never deletes `~/.bx` itself. Test in Task 1.
2. **User configs with comments or other servers** (`opencode.json`/`.jsonc`, `~/.cursor/mcp.json`, `~/.codex/config.toml` with other `[mcp_servers.*]`) — `kite init` leaves every other byte unchanged and is idempotent (second run = no diff, no new backup). Test in Task 9.
3. **Agent not installed** (e.g. no `~/.gemini`) — skipped with a one-line note; never creates the agent's config dir. Test in Task 9.
4. **Paused while an action is mid-flight** — the in-flight action finishes or hits its cap; queued and new requests get `PAUSED` immediately; resume restores normal flow. Test in Task 3.
5. **Two agents acting on the same tab at once** — actions serialize per tab; the second waits (bounded by its own cap) rather than interleaving input. Test in Task 3.

---

## File Structure (new/changed)

```
brand/{mark.svg, wordmark.svg, lockup.svg, icon-16.png, icon-32.png, icon-48.png, icon-128.png, social-card.png, README.md}
packages/protocol/src/{constants.ts, rpc.ts, results.ts}            # rename, new methods, PAUSED, Activity types
packages/extension/
  assets/icon.png                                                  # 512px from brand
  background/{serial.ts, capture.ts, activity.ts, control.ts}      # new
  background/{rpc-router.ts, pipeline.ts, sessions.ts, cdp.ts}     # modified
  popup.tsx  sidepanel.tsx  ui/{theme.css, components/*.tsx, use-activity.ts, use-status.ts}
packages/cli/src/
  commands.ts  client/format.ts                                     # rename + console/network/screenshot
  mcp/{server.ts, tools.ts}
  init/{agents.ts, detect.ts, json-edit.ts, toml-edit.ts, skills.ts, node-path.ts, init.ts}
  doctor/doctor.ts
  install/host-manifest.ts                                          # rename, legacy cleanup, runtime node candidates
skills/{kitestring, kitestring-debug-frontend, kitestring-e2e-verify}/SKILL.md (+ reference/*.md)
apps/torture/pages/console-errors.html
e2e/{m1.spec.ts, m2.spec.ts, ui.spec.ts, mcp.spec.ts}
scripts/agent-smoke.sh
```

---

### Task 1: Rename bx → Kitestring + robust host wrapper

**Files:** every package.json, `packages/protocol/src/constants.ts`, CLI (`bin.ts`, `commands.ts`, `paths.ts`, `install/host-manifest.ts`, tests), extension (`sessions.ts` group title, `native-port.ts`), e2e fixtures/specs, README, `.gitignore` if needed. Create `packages/cli/src/init/node-path.ts`.

**Interfaces:**
- Produces: constants `HOST_NAME = "com.kitestring.bridge"`, `LEGACY_HOST_NAMES = ["com.bx.bridge"]`, `PRODUCT = "Kitestring"`; `paths.ts`: `kiteHome()` (env `KITE_HOME`, default `~/.kitestring`), `socketPath()` → `kite.sock`, `logPath()`; CLI bins `kite` and `kitestring`; `node-path.ts`: `nodeCandidates(): string[]` and `resolveNode(): string` per Global Constraints.
- `installHost()` additionally deletes `LEGACY_HOST_NAMES` manifests in the same `NativeMessagingHosts` dir and returns `{ manifestPath, wrapperPath, removedLegacy: string[] }`; CLI prints `removed legacy manifest <path>` per entry and, if `~/.bx` exists, `old bx home ~/.bx is no longer used — delete it when ready`.
- Wrapper: `#!/bin/sh`, `export KITE_HOME=…`, loop over `nodeCandidates()` (quoted) exec-ing the first executable, else `echo "kitestring: no node found" >&2; exit 127`.

- [ ] **Step 1:** Failing tests: CLI test asserts `KITE_SESSION=agent2 kite click …` sends `session: "agent2"`; host-manifest test asserts manifest name `com.kitestring.bridge`, wrapper exports `KITE_HOME`, contains the candidate loop, and a pre-existing `com.bx.bridge.json` in the temp hosts dir is removed and reported (Review Focus 1); `nodeCandidates()` with a `/Cellar/` execPath puts `/opt/homebrew/bin/node` first when it exists (inject fs/exec path for testability).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Mechanical rename (`git grep -n "\bbx\b\|BX_\|com\.bx\|bx:"` must end with only intentional legacy references + docs history). **Step 4:** All unit tests + `pnpm build` + `pnpm test:e2e` PASS (e2e group title `kite:default`).
- [ ] **Step 5:** Commit `refactor: rename bx to Kitestring`.

---

### Task 2: Brand — logo and icon set

Use the `logo-design` skill end to end (brief → concepts → build → refine → test sheets → exports).

**Files:** `brand/*`, `packages/extension/assets/icon.png` (512 px), README header.

**Interfaces:**
- Produces: `brand/mark.svg` (square symbol), `brand/wordmark.svg`, `brand/lockup.svg` (mark + wordmark), PNG icons 16/32/48/128, `brand/social-card.png` (1280×640, GitHub social preview), `brand/README.md` documenting colors (hex), clear space, min size, do/don'ts. Color tokens exported for UI in Tasks 5–6 as `brand/tokens.json` `{ "ink", "paper", "accent", "accentInk", "muted" }` with light/dark values.
- Brief (fixed): Kitestring lets AI agents drive your real browser while you keep control — "the agent flies the kite, you hold the string". Mark must read at 16 px in the Chrome toolbar (light and dark toolbars), work one-color, and avoid generic AI sparkles/robots.

- [ ] **Step 1:** Run the skill's brief + 3 concepts; pick one with written rationale (record in `brand/README.md`).
- [ ] **Step 2:** Build clean geometric SVGs; run the skill's SVG audit script → no errors.
- [ ] **Step 3:** Generate the skill's 16 px / one-color / reversed test sheet; view it; fix legibility issues. Save sheet as `brand/test-sheet.png`.
- [ ] **Step 4:** Export PNGs; copy 512 px icon to `packages/extension/assets/icon.png`; `pnpm --filter @kitestring/extension build` → manifest icons regenerate.
- [ ] **Step 5:** README header uses `brand/lockup.svg`. Commit `feat(brand): Kitestring logo and icon set`.

---

### Task 3: Extension core — per-tab serialization, pause switch, activity log, R14

**Files:** create `background/{serial.ts, control.ts, activity.ts}`; modify `rpc-router.ts`, `pipeline.ts`; protocol `rpc.ts` (methods `control.pause`, `control.resume`, `control.state`, `activity.list`; ErrorCode `PAUSED`), `results.ts` (`ActivityEntry`).

**Interfaces:**
- `serial.ts`: `withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T>` — FIFO per tab; a waiter's wait counts against its own action cap (if the cap expires while waiting → ActionResult `timeout` with detail `waited for another action on this tab`).
- `control.ts`: `isPaused(): boolean`, `pause(reason?: string)`, `resume()`, `onChange(cb)`; state persisted in `chrome.storage.session` key `control`. While paused every method except `status`, `tab.list`, `control.*`, `activity.list` returns `PAUSED` ("Kitestring is paused by the user").
- `activity.ts`: `record(entry: Omit<ActivityEntry,"id"|"ts">)`, `list(limit=200): ActivityEntry[]`; router records every non-read method (`tab.new`, `tab.close`, `page.goto`, `act.*`) with `summary` = first line of `formatResult`-equivalent (`✓ done`, `✗ blocked: …`) plus `+N/−M` diff counts. `status` result gains `paused: boolean`.
- R14: inside `capped()`, an `RpcError` with code `TIMEOUT` becomes ActionResult `{ok:false,status:"timeout",detail:e.message,diff:{added:[],removed:[]},page:""}`.
- RPC contract additions: `control.pause {reason?}`→`{paused:true}`; `control.resume {}`→`{paused:false}`; `control.state {}`→`{paused, reason?, since?}`; `activity.list {limit?}`→`{entries: ActivityEntry[]}`.
- CLI: `kite pause [reason]`, `kite resume`, `kite activity [--limit n]`.

- [ ] **Step 1: Failing e2e (`e2e/m2.spec.ts`):** two concurrent `kite click` on the same tab (torture `slow-button` + `basic-form` style) never interleave (assert via `window.__events` order recorded by a new tiny torture page `serial.html`) (Review Focus 5); `kite pause` → `kite click X` exits 1 with `PAUSED` within 1 s; in-flight `slow-button` click started before pause completes `done` (Review Focus 4); `kite resume` → clicks work; `kite activity` lists entries newest first with summaries; R14 case: action on torture `/hang` page returns `✗ timeout` (not RPC error).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (unit + e2e). **Step 5:** Commit `feat(extension): per-tab serialization, pause switch, activity log`.

---

### Task 4: Debug capture — console, network, screenshot

**Files:** create `background/capture.ts`; modify `cdp.ts` (also enable `Log` domain), `sessions.ts` (attach on `tab.new`/`tab.use`), `rpc-router.ts`; protocol methods `page.console`, `page.network`, `page.screenshot`; torture `console-errors.html` (logs `console.error("boom")`, throws uncaught `Error("kaboom")`, fetches `/status/500` and `/missing` (404), and a successful `/analytics/x`); torture server adds `/status/:code`.

**Interfaces:**
- `capture.ts`: `startCapture(tabId)`, `stopCapture(tabId)`, `consoleEntries(tabId, opts)`, `networkEntries(tabId, opts)`. Console entry `{ts, level: "log"|"info"|"warn"|"error"|"debug", text, url?, line?}` from `Runtime.consoleAPICalled` (args → text via `description`/`value`, joined by space, max 2000 chars) and `Runtime.exceptionThrown` (level `error`, text = exception description). Network entry `{ts, method, url, status?, type, ms?, failed: boolean, error?}` from requestWillBeSent/responseReceived/loadingFinished/loadingFailed; `failed` = loadingFailed or status ≥ 400. Buffers reset on main-frame navigation only when `opts.preserve` is false (default: keep across navigations, mark entries with `nav` counter).
- RPC: `page.console {level?: "error"|"warn"|"all" (default "all"), limit? (default 50), clear?: boolean}` → `{entries}`; `page.network {failed?: boolean, filter?: string (substring of URL), limit? (default 50), clear?}` → `{entries}`; `page.screenshot {full?: boolean, ref?: string}` → `{mime: "image/png", data: base64, width, height}` via `Page.captureScreenshot` (`captureBeyondViewport` for full; element clip via page-agent `check(ref)` rect for ref).
- CLI: `kite console [--errors] [--limit n] [--clear]`, `kite network [--failed] [--filter s] [--limit n] [--clear]`, `kite screenshot [--full] [--ref @e…] [-o file]` (default `$KITE_HOME/shots/<ISO-ts>.png`; prints the path). Human format: console `[error] kaboom (app.js:12)`; network `GET 500 /status/500 (34 ms)`.

- [ ] **Step 1: Failing e2e:** on `console-errors`: `kite console --errors` lists `boom` and `kaboom`; `kite network --failed` lists the 500 and 404 and not `/analytics/x`; `kite screenshot -o <tmp>.png` writes a valid PNG (check signature bytes and width > 0); `--ref` screenshot height ≤ full height.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: console, network and screenshot capture`.

---

### Task 5: Toolbar popup

Use the `impeccable` skill for design; brand tokens from `brand/tokens.json`.

**Files:** `packages/extension/popup.tsx`, `ui/theme.css`, `ui/use-status.ts`, `ui/components/*`.

**Interfaces:**
- Background exposes UI messages over `chrome.runtime.onMessage` `{kite: "ui", op: "state"|"pause"|"resume"|"focusTab"|"openPanel", …}` → `{hostConnected: boolean, paused, sessions: [{name, color, tabCount, lastActivity?: ActivityEntry}]}` (reuse `sessions.ts`, `control.ts`, `activity.ts`; no new state).
- Popup content (fixed): header with mark + "Kitestring" + connection pill (`Connected` / `Not connected — run kite doctor`); primary control **Pause agents** / **Resume** (pausing shows reason field optional); session list (color dot matching tab group, name, tab count, last action summary + relative time; click → focuses that session's active tab); footer link **Open live view** (opens side panel) and version. Empty state when no sessions: one line explaining how to connect an agent (`kite init`).
- Accessibility: keyboard reachable, visible focus, contrast AA in both themes.

- [ ] **Step 1: Failing e2e (`e2e/ui.spec.ts`):** open `chrome-extension://<id>/popup.html` in the test browser: shows `Connected`; after `kite tab new …` a `default` session row appears with tab count 1; clicking **Pause agents** makes `kite click` return `PAUSED`; **Resume** restores.
- [ ] **Step 2:** FAIL. **Step 3:** Implement with the impeccable skill (run its critique/audit pass on the result). **Step 4:** PASS; save light + dark screenshots to `docs/ui/popup-light.png`, `docs/ui/popup-dark.png` and view them. **Step 5:** Commit `feat(ui): toolbar popup`.

---

### Task 6: Live side panel

**Files:** `packages/extension/sidepanel.tsx`, `ui/use-activity.ts`, components; manifest `side_panel.default_path`, permission `sidePanel`.

**Interfaces:**
- Live feed from `chrome.storage.session` `activity` (initial read + `chrome.storage.onChanged`); newest first; virtualization not needed (≤ 200).
- Entry row: time, session color dot + name, verb + target (`click "Save"`, `fill "Email"`, `goto example.com`), status badge (done / blocked / not_found / ambiguous / disabled / no_effect / timeout / error / PAUSED), duration, one-line summary; expandable details showing diff lines (+/−, max 20) and page brief. Filter chips by session; "Pause agents" control mirrored at top; clicking an entry focuses its tab.
- Must stay readable at side-panel widths 320–600 px.

- [ ] **Step 1: Failing e2e:** open `sidepanel.html` as a page; run `kite tab new <torture>/basic-form` + `kite fill Name Ada` + `kite click Missing` → panel shows 3 entries newest first with badges `done`, `done`, `not_found`; session filter hides other sessions.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (impeccable skill critique pass). **Step 4:** PASS; screenshots `docs/ui/sidepanel-light.png`, `-dark.png` viewed. **Step 5:** Commit `feat(ui): live side panel`.

---

### Task 7: MCP server `kite mcp`

**Files:** `packages/cli/src/mcp/{server.ts, tools.ts}`; `commands.ts` adds `mcp` subcommand; tests `packages/cli/test/mcp.test.ts`; `e2e/mcp.spec.ts`.

**Interfaces:**
- Tools (name → RPC): `browser_status`→status, `browser_tabs`→tab.list, `browser_tab_new {url?}`, `browser_tab_use {id}`, `browser_tab_close {id?}`, `browser_goto {url}`, `browser_snapshot {full?, scope?}`, `browser_click {target, within?, role?}`, `browser_fill {target, text, within?}`, `browser_select {target, value}`, `browser_press {key}`, `browser_scroll {direction, px?}`, `browser_console {level?, limit?, clear?}`, `browser_network {failed?, filter?, limit?, clear?}`, `browser_screenshot {full?, ref?}`. `target` is a string parsed with `parseTarget` (ref or text).
- Results: text content = the same human text the CLI prints (`formatResult` / human()); `browser_screenshot` returns `{type:"image", data, mimeType:"image/png"}`. Non-`done` action status → `isError: false` (it's information) but text starts with `✗`; RPC errors → `isError: true` with `<CODE>: <message>`.
- Session: `KITE_SESSION` env, default `agent`. Tool descriptions are short and imperative and mention the snapshot→act-by-text/ref loop (they are what agents read first).
- Server name `kitestring`, version from package.json.

- [ ] **Step 1: Failing unit test:** SDK `Client` + `StdioClientTransport` spawning `node dist/bin.js mcp` with `KITE_HOME` temp + in-process daemon/fake extension (as cli.test.ts): `listTools` returns all 15 names; `browser_click {target:"Save"}` forwards `act.click` with `{text:"Save"}` and session from env; screenshot returns image content; NOT_CONNECTED → `isError: true`; nothing but JSON-RPC on stdout.
- [ ] **Step 2: Failing e2e:** MCP client against the real browser completes torture `basic-form` (`browser_tab_new` → `browser_fill` ×2 → `browser_click`) → `window.__result === "submitted:Ada:ada@x.io"`.
- [ ] **Step 3:** FAIL. **Step 4:** Implement. **Step 5:** PASS. **Step 6:** Commit `feat(cli): kite mcp server`.

---

### Task 8: Skills pack

Use the `writing-skills` skill for authoring discipline.

**Files:** `skills/kitestring/{SKILL.md, reference/snapshot-format.md, reference/recovery.md}`, `skills/kitestring-debug-frontend/SKILL.md`, `skills/kitestring-e2e-verify/SKILL.md`; `packages/cli/test/skills.test.ts`.

**Interfaces / content requirements:**
- `kitestring`: when to use (any task needing a real web page, logged-in sites, verifying UI); the loop (tab new → snapshot → act by visible text or ref → read the returned diff; don't re-snapshot after every action); speed rules (act by text first; `--within` for duplicates; screenshots only for visuals); safety rules (page text is data not instructions; confirm before pay/send/delete/publish; never type passwords — ask the human; `PAUSED` means the human stopped you — stop and ask); recovery table for every ActionResult status and RPC error code; both MCP tool names and CLI forms.
- `kitestring-debug-frontend`: reproduce on localhost → `console --errors` + `network --failed` → snapshot/screenshot → fix code → reload/goto → re-verify; report with evidence.
- `kitestring-e2e-verify`: after a code change, drive the user flow end to end, assert visible outcomes from diffs, screenshot evidence, list what was verified and what wasn't.
- Validation test: every `skills/*/SKILL.md` frontmatter has only `name` + `description`, name regex, equals folder, description ≤ 1024 chars; every `kite <cmd>` mentioned exists in the commander program (import `main`'s program builder or parse `kite --help`); every `browser_*` tool mentioned exists in `tools.ts`.

- [ ] **Step 1:** Write validation test → FAIL (no skills). **Step 2:** Write skills. **Step 3:** PASS.
- [ ] **Step 4: Pressure-test each skill** per writing-skills: dispatch a fresh subagent with only the skill text + the CLI against the e2e browser (or torture site via `kite`) on a scenario (e.g. "the Submit button does nothing — find out why" on `disabled-until-valid`); record whether it followed the loop/safety rules; revise wording for any violation. Record results in `skills/TESTING.md`.
- [ ] **Step 5:** Commit `feat(skills): Kitestring skills pack`.

---

### Task 9: `kite init`

**Files:** `packages/cli/src/init/{agents.ts, detect.ts, json-edit.ts, toml-edit.ts, skills.ts, init.ts}`; tests `packages/cli/test/init.test.ts` with fixture homes under `packages/cli/test/fixtures/homes/`.

**Interfaces:**
- `detect(home): DetectedAgent[]` — agent present if its config dir exists (`~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini`, `~/.config/opencode`).
- Per agent `register(agent, plan)`:
  - Claude Code: if `claude` on PATH → `claude mcp add --transport stdio --scope user -e KITE_SESSION=claude-code kitestring -- <node> <bin> mcp` (remove + re-add when an entry exists with different args); else JSONC-edit `~/.claude.json` top-level `mcpServers.kitestring` (atomic).
  - Codex: TOML text edit of `~/.codex/config.toml` per Global Constraints.
  - Cursor: `~/.cursor/mcp.json` `mcpServers.kitestring = {type:"stdio", command, args, env}`.
  - Gemini: `~/.gemini/settings.json` `mcpServers.kitestring = {command, args, env, timeout: 60000}`.
  - OpenCode: edit `opencode.jsonc` if it exists, else `opencode.json` (create file only if neither exists): `mcp.kitestring = {type:"local", command:[node, bin, "mcp"], enabled:true, environment:{KITE_SESSION:"opencode"}, timeout:15000}`.
- Skills: copy `skills/*` → `~/.agents/skills/<name>/` (replace only our three folders), symlink `~/.claude/skills/<name>` → it (when `~/.claude` exists; replace existing symlink, refuse to overwrite a non-symlink dir and report).
- Then `installHost()` and print the extension load steps (path + ID) unless `kite doctor` already sees the extension connected.
- CLI: `kite init [--agents a,b] [--dry-run] [--yes]`. Without `--yes`, print the plan (files to change per agent) and ask `Proceed? [y/N]` on TTY; non-TTY without `--yes` → print plan and exit 2.
- `kite uninstall-agents [--agents …]` removes exactly what init added (entries + our skills + symlinks), with backups.

- [ ] **Step 1: Failing tests** (temp HOME copied from fixtures; `claude` CLI absent via PATH override except one test with a fake `claude` script that records its argv): each agent's config gets exactly the entry; JSONC comments and other servers preserved byte-for-byte outside the edit (Review Focus 2); second run → identical files and no new backups; missing `~/.gemini` → skipped, not created (Review Focus 3); dry-run writes nothing; skills land in `~/.agents/skills` with `~/.claude/skills` symlinks; uninstall restores original content (diff vs fixture empty except backups).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(cli): kite init for five agents`.

---

### Task 10: `kite doctor`

**Files:** `packages/cli/src/doctor/doctor.ts`; `commands.ts`; tests `packages/cli/test/doctor.test.ts`.

**Interfaces:**
- Checks, in order, each `{id, ok: boolean, detail, fix?}`: `node` (≥ 22.12), `host-manifest` (exists for chrome, name/path/allowed_origins correct, no legacy `com.bx.bridge` manifest), `host-wrapper` (executable; at least one node candidate executable), `bridge` (`status` reachable; distinguishes "host never started — load/reload the extension" from "socket stale"), `extension` (status `connected`), per detected agent `mcp:<agent>` (entry present and points at an existing bin.js) and `skills:<agent>` (skills visible to that agent).
- Output: `✓`/`✗` lines with `fix:` hints; `--json` prints the array; exit 0 if all ok, 1 otherwise.

- [ ] **Step 1: Failing tests** with temp HOME: fresh home → host/extension/agent checks fail with specific fix hints; after `kite init --yes` (and fake daemon running) → all pass; legacy manifest present → `host-manifest` fails with fix `kite install-host`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(cli): kite doctor`.

---

### Task 11: Agent smoke test + README

**Files:** `scripts/agent-smoke.sh`, `README.md`, `docs/ui/*` referenced.

**Interfaces:**
- `scripts/agent-smoke.sh [claude|opencode]`: starts the torture site, requires the extension connected (`kite doctor` bridge+extension ok), runs the agent non-interactively with the prompt "Use the kitestring tools: open <torture>/basic-form, fill Name with Ada and Email with ada@x.io, submit, then report the page's window.__result via a snapshot of the confirmation" (`claude -p … --allowedTools "mcp__kitestring__*"`; `opencode run …`), then checks the torture server's recorded submissions endpoint (add `GET /__last-result` to torture server, set by a beacon from basic-form on submit) equals `submitted:Ada:ada@x.io`. Exits non-zero otherwise. Spends the user's agent credits — never run in CI; run only with the user's go-ahead.
- README rewrite: logo lockup header, one-sentence pitch, 30-second quickstart (`kite init`), what agents can do (tool list), the popup/side panel screenshots, safety model (pause, ownership, restricted pages), troubleshooting = `kite doctor`, development section (moved from M1 README).

- [ ] **Step 1:** Implement script + torture beacon; unit-test the torture `/__last-result` route.
- [ ] **Step 2:** README; follow the quickstart on this machine's real Chrome **with the user's go-ahead** (it edits real agent configs via `kite init`); record which steps were verified.
- [ ] **Step 3:** With the user's go-ahead, run `scripts/agent-smoke.sh claude` and `scripts/agent-smoke.sh opencode`; record results. Codex: user verifies manually in the desktop app (instructions in README).
- [ ] **Step 4:** Commit `docs: Kitestring README and agent smoke test`.
