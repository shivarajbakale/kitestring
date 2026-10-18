# Kitestring M6 — Speed + Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repeat tasks run several times faster than the first run (cached elements; stored plans replayed with zero model calls), the agent that is already connected (Claude Code, OpenCode, Codex…) does all the planning — Kitestring itself never calls a model — a human can record a task once and get a reusable skill, and the project is ready for a Web Store submission the user makes.

**Architecture:** The extension gains an action cache (background-owned, hinted into the page agent's FIND). The CLI gains a site-memory store of parameterized plans under `$KITE_HOME/memory` (filled automatically from the agent's ok batches, saved on request), `kite run` / `browser_plan_run` to replay a plan on top of `act.batch` and hand back to the agent at the first halt, a recorder (content script in the page, RPC to start/stop, CLI writes the skill), a benchmark app, Windows install paths, and a Store packaging script.

**Tech Stack:** As M3. No new runtime dependencies in the extension. No model client, no API keys, no network calls from Kitestring. Bench may add `gifenc` (dev only) for the demo GIF.

**Spec:** `docs/superpowers/specs/2026-10-18-kitestring-m3-m6-design.md` Part B + §D2 (#5, #6 bind M6). Parent: `docs/superpowers/specs/2026-10-17-bx-design.md`.
**User decision (2026-10-18, overrides the spec's `kite do` / DeepSeek parts and §D2 #8):** no built-in model. "Let it be on the agent that integrates with this." The connected agent plans; Kitestring remembers and replays. `kite do`, the planner client, `DEEPSEEK_*` env and the model doctor check are out of scope.

## Global Constraints

- No model calls anywhere in Kitestring. Planning is the connected agent's job; Kitestring stores plans, replays them, and reports exactly where a replay stopped so the agent takes over from that page.
- Replay (`kite run`, `browser_plan_run`): runs the plan's batches with `act.batch`; stops at the first halt and returns `{ok:false, stoppedAt:{batch, step, reason, detail}, result}` plus the halted step's text; a `risky` halt is never auto-continued (CLI exit 3). Upload steps in a replay take files only from `--param`/`params` values and go through the M3 deny list.
- Pending journal: every ok `act.batch` sent through the CLI or MCP appends its steps, already parameterized by `buildPlan` (no values), to `$KITE_HOME/memory/.pending/<session>.json` (0600, max 200 steps, cleared on save or on `kite memory discard`). `kite memory save "<intent>"` / `browser_plan_save {intent}` turns it into a plan.
- Plans (D2 #5): `$KITE_HOME/memory/<origin-slug>/<plan-slug>.json`, dirs 0700, files 0600. Schema `{ version: 1, intent, origin, pathPattern, params: {name, secret}[], batches: Step[][], createdAt, runs, lastOk }`. **No example values, ever.** Every fill/select value and upload file is a `{{param}}` named from its target (`slug(target text)`, deduped with `_2`); secret = field was password / cc-* / one-time-code. Targets are written from `StepResult.resolved` as `{text: name, role, within?}` — never `@refs`.
- Plan match: same origin, then intent token overlap (Jaccard on normalized word sets, stopwords removed) ≥ 0.6, best score wins; `--plan <slug>` forces.
- Path pattern: numeric segments, UUIDs, and hex/base64-ish segments ≥ 16 chars → `*`. One function, `pathPattern(url)` in `@kitestring/protocol`, used by cache and memory.
- Action cache (D2 #6): background-owned `Map`, flushed to `chrome.storage.local` key `kite.cache` at most every 5_000 ms; LRU cap 5_000 entries; key `origin + pathPattern + norm(text) + role? + within?`; value `{ref, role, name, landmarkPath, cssPath, nth, hits, lastUsed}`; hint accepted only if role matches and name score ≥ 70; result field `cached: true` on ActionResult/StepResult when the hint was used. Never cache upload targets' files (locator only) and never cache when the target field is secret.
- Recording: only the human's events in the recorded tab; values become params (D2 #5: no values stored); secret fields never stored; file inputs record basenames only as params. Output skill `~/.agents/skills/kite-<slug>/SKILL.md` + `~/.claude/skills/kite-<slug>` symlink (as `kite init` does) + the plan in memory. Existing folder → refuse unless `--force` (backup to `~/.agents/kite-backups/skills/`).
- Bench: all modes are scripted and spend no credits.
- Windows: code + unit tests only (mocked `process.platform`/`execFile`); README states "Windows: untested". Named pipe `\\.\pipe\kitestring-<username>`.
- Store package strips `manifest.key`; host `allowed_origins` = `EXTENSION_ID` plus `KITE_STORE_EXTENSION_ID` when non-empty (constant `""` until the user's first upload).
- Nothing is published, pushed, or submitted by the builder.
- Zod: protocol/extension `~3.24.4`; CLI `^3.25`. Conventional commits with the M3 trailers.

## Review Focus

1. **A plan stored with a hostile or leaked value** (a field the agent typed a password into without it being `type=password`, or a page that renamed a button to "Publish" since recording) — no value ever lands in pending/plan files (values are params before the write), and a replayed click whose resolved name is risky halts `risky`. Test in Task 3.
2. **Stored plan replayed on a changed page** (field renamed, extra required field) — replay halts at the first broken step and returns where it stopped and why, with the page left there for the agent; the plan is updated (`runs`, `lastOk`) only after a fully ok run. Test in Task 3.
3. **Cache hint points at a different element after a redesign** (same text, other role / name score < 70) — hint rejected, normal FIND, entry overwritten; never acts on a stale element. Test in Task 1.
4. **Recording a login form** — password and OTP values never reach disk (plan, skill, logs). Test in Task 4.
5. **Replay with a missing or extra parameter** — `kite run` exits 2 listing every missing param name before touching the browser; unknown `--param` names are an error, not silently ignored. Test in Task 3.

---

## File Structure (new/changed)

```
packages/protocol/src/{path-pattern.ts, plan.ts}              # pathPattern(), Plan type + slug helpers
packages/page-agent/src/{find.ts, locator.ts, recorder.ts, snapshot.ts}
packages/extension/background/{cache.ts, recorder.ts}        # new
packages/extension/background/{pipeline.ts, rpc-router.ts}
packages/extension/{sidepanel.tsx, ui/…}                     # recording banner
packages/cli/src/memory/{store.ts, build.ts}                 # plans on disk; build plan from batch results
packages/cli/src/memory/{pending.ts, replay.ts}
packages/cli/src/record/write-skill.ts
packages/cli/src/{commands.ts, doctor/doctor.ts, paths.ts, install/host-manifest.ts, install/shim.ts, init/agents.ts}
apps/bench/{package.json, bench.ts, tasks.ts, gif.ts}
store/{listing.md, privacy.md, screenshots/}
scripts/package-store.mjs
docs/bench.md  docs/demo.gif  README.md
e2e/m6.spec.ts
```

---

### Task 1: Action cache

**Files:** create `packages/protocol/src/path-pattern.ts` (+ test), `packages/page-agent/src/locator.ts` (+ spec), `packages/extension/background/cache.ts` (+ `test/cache.test.ts`); modify `page-agent/src/find.ts` + `index.ts` (agent `find(target, intent, hint?)`), `pipeline.ts` (FIND passes hint, updates cache, sets `cached`), `protocol` `results.ts`/`batch.ts` (`cached?: boolean` on ActionResult and StepResult), `rpc.ts` (`cache.stats`, `cache.clear`), `rpc-router.ts`, CLI `commands.ts` (`kite cache stats | clear [--site <origin>]`), `client/format.ts`.

**Interfaces (Produces):**
- `pathPattern(url: string): string` — `"/a/123/b"` → `"/a/*/b"`; UUID and long hex/base64 segments → `*`; keeps query out.
- `locator.ts`: `describeLocator(el, reg): Locator` (`{ref, role, name, landmarkPath: string[], cssPath, nth}`) and `resolveLocator(doc, reg, loc): Element | null` (try ref → cssPath → role+name within landmark).
- Agent `find(target, intent, hint?: Locator)` → `FindResult` gains `locator: Locator` on `found` and `hinted: boolean`.
- `cache.ts`: `cacheKey(url: string, target: Target): string`, `getHint(key): Locator | undefined`, `remember(key, loc)`, `stats(): {entries, hits, sites}`, `clear(site?: string)`; persistence per Global Constraints.

- [ ] **Step 1: Failing tests:** path-pattern cases; locator spec: hint resolves after a re-render (same content), hint rejected when role changed or name score < 70 (Review Focus 3); cache.test: LRU evicts the least-recently-used at 5_001, flush coalesces writes within 5 s, `clear("https://a.test")` removes only that origin.
- [ ] **Step 2: Failing e2e** (`e2e/m6.spec.ts`): run `basic-form` fill+submit twice in fresh page loads → second run's `--json` results have `cached: true` on all three steps; `kite cache stats` shows ≥ 3 entries; `kite cache clear` → next run `cached` absent.
- [ ] **Step 3:** FAIL. **Step 4:** Implement. **Step 5:** PASS + full e2e green. **Step 6:** Commit `feat: action cache with self-healing locator hints`.

---

### Task 2: Site memory — plans on disk

**Files:** create `packages/protocol/src/plan.ts` (types, `slug()`, `paramName(target)`), `packages/cli/src/memory/{store.ts, build.ts}` (+ tests); CLI `kite memory list | show <slug> | forget <slug>`.

**Interfaces (Produces):**
- `store.ts`: `savePlan(home: string, plan: Plan): string` (path), `loadPlans(home, origin?): Plan[]`, `findPlan(home, origin, intent): {plan, score} | undefined` (rule in Global Constraints), `forgetPlan(home, slug): boolean`. Atomic writes, modes 0700/0600.
- `build.ts`: `buildPlan(intent: string, url: string, sent: Step[][], results: BatchResult[], secrets: Set<string>): Plan` — keeps only steps that ran ok, replaces values/files with `{{param}}` per Global Constraints, targets from `resolved`; `fillPlan(plan, values: Record<string, string>): Step[][]` (throws `missing parameter: <name>`).

- [ ] **Step 1: Failing tests:** build from a 2-batch store-listing run → no literal value appears anywhere in `JSON.stringify(plan)`; password field → param `secret: true`; `@ref` targets replaced by `{text, role}` from `resolved`; duplicate target names → `title`, `title_2`; `findPlan` picks the 0.75-overlap plan over a 0.5 one and returns undefined below 0.6; files 0600 / dirs 0700; `fillPlan` missing value throws.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(cli): site memory of parameterized plans`.

---

### Task 3: Plan replay, pending journal, agent tools

**Files:** create `packages/cli/src/memory/{pending.ts, replay.ts}` (+ unit tests with a fake RPC); modify `commands.ts` (`kite batch` appends to pending; `kite run <slug> [--param k=v...] [--secret k=v...] [--dry-run] [--json]`; `kite memory save "<intent>" | discard`), `mcp/tools.ts` (`browser_batch` appends to pending; new tools `browser_plan_find {intent}` → best plan `{slug, intent, params, score}` or none, `browser_plan_run {slug, params}`, `browser_plan_save {intent}`), `client/format.ts`, `skills/kitestring/SKILL.md` (a "Remembered tasks" section: before a multi-step task call `browser_plan_find`; if found, run it and take over at `stoppedAt`; after finishing a new multi-step task, `browser_plan_save`), `e2e/m6.spec.ts`.

**Interfaces:**
- `pending.ts`: `appendPending(home, session, url, steps: Step[], result: BatchResult, secrets: Set<string>): void` (uses `buildPlan` param rules; skips non-ok steps; secrets = fields reported secret by results), `takePending(home, session): {url, batches: Step[][]} | undefined`, `discardPending(home, session)`.
- `replay.ts`: `runPlan(plan: Plan, values: Record<string,string>, deps: {call: RpcCall; out?: (s: string) => void; dryRun?: boolean}): Promise<ReplayResult>` — `ReplayResult = { ok: boolean; batches: number; ms: number; stoppedAt?: {batch: number; step: number; reason: HaltReason | "missing_param"; detail: string; stepText: string}; missing?: string[] }`. Validates params first (missing → `{ok:false, missing}`, unknown names → `KiteError("BAD_REQUEST")`); on full ok bumps `runs`/`lastOk` via `savePlan`.
- Output (human): `ran plan store-listing-fill · 3 batches · 2.1 s · ✓` or `stopped at batch 2 step 4 (not_found: "Short description") — page left there, take over`.

- [ ] **Step 1: Failing unit tests:** pending journal after two ok batches with a typed email and a password contains neither value; `save` produces a plan equal to `buildPlan` of the same run and clears pending; `runPlan` with all params → 0 halts, `runs` bumped; missing param → `missing` lists all names, no RPC sent (Review Focus 5); unknown param → BAD_REQUEST; changed page → `stoppedAt` names the step, plan file unchanged (Review Focus 2); replayed click resolved to "Publish" → `risky`, exit 3 in the CLI (Review Focus 1); `--dry-run` prints the filled batches with secrets as `••••` and sends no `act.*`.
- [ ] **Step 2: Failing e2e:** agent-style first run on `multi-page-checkout` (scripted `kite batch` per page up to before "Place order") → `kite memory save "fill the shipping form"` → plan exists; `kite run <slug> --param …` on a fresh load completes to the same point in fewer ms than the first run and reports `cached: true` steps; MCP `browser_plan_find` returns it for "fill shipping form" and none for "delete my account".
- [ ] **Step 3:** FAIL. **Step 4:** Implement. **Step 5:** PASS + full e2e. **Step 6:** Commit `feat(cli): remember agent runs as plans and replay them`.

---

### Task 4: Record → skill

**Files:** create `packages/page-agent/src/recorder.ts` (+ spec), `packages/extension/background/recorder.ts`, `packages/cli/src/record/write-skill.ts` (+ test); modify `protocol` `rpc.ts` (`record.start {name}`, `record.stop` → `{name, url, steps: Step[], secrets: string[]}`), `rpc-router.ts`, extension content entry (recorder injected only while recording), `sidepanel.tsx` (banner "Recording <name>" + Stop), `commands.ts` (`kite record start --name <slug>`, `kite record stop [--force]`).

**Interfaces:**
- Recorder captures, in the recorded tab only: click (on interactive roles), change/commit of text fields (blur or Enter), select change, form submit, file input change; each → a `Step` with a text target `{text: name, role, within?}` from page-agent `nameOf/roleOf` + nearest landmark; navigations caused by a step → that step gets `expect: {url: <pathPattern of new URL>}`. Values: text/select values are replaced by `{{param}}` in the page agent before leaving the page; password / cc-* / one-time-code fields are marked secret and their values never leave the page; file inputs → basenames as params.
- `writeSkill(home, rec, opts: {force: boolean}): {skillPath, planSlug}` — SKILL.md frontmatter `name: kite-<slug>`, `description: Replays <intent-ish summary> on <origin> with Kitestring. Use when the user asks to <name words> on <host>.`; body: when to use, parameter table (name, secret yes/no), and a fenced `kite batch` JSON block with `{{param}}` placeholders and a note that the agent fills them; also `savePlan`.

- [ ] **Step 1: Failing tests:** recorder spec on a login fixture: password and OTP values absent from the emitted steps (Review Focus 4); select/text become params; write-skill test: frontmatter exact, symlink created, existing folder refused without `--force` and backed up with it.
- [ ] **Step 2: Failing e2e:** `kite record start --name ada-signup` on `basic-form`; Playwright types/clicks as the human; `kite record stop` → skill file exists, contains no `Ada`/`ada@x.io`; `kite batch` with the skill's JSON and values substituted completes the form.
- [ ] **Step 3:** FAIL. **Step 4:** Implement. **Step 5:** PASS + full e2e. **Step 6:** Commit `feat: record a task once, replay it as a skill`.

---

### Task 5: Benchmark

**Files:** create `apps/bench/{package.json, bench.ts, tasks.ts}` (reuses `e2e/fixtures` launch logic via a small shared helper — move the launch/install-host code from `e2e/fixtures.ts` into `e2e/launch.ts` exported for both), `docs/bench.md`; root `package.json` script `bench`.

**Interfaces:**
- Tasks: `multi-page-checkout` (to the risky halt), `store-listing` (fill + save), `cookie-wall`, `file-upload`. Modes: 1 single actions (scripted list, as an agent calling one tool per field), 2 one batch per page (scripted), 3 plan replay (`kite run`) with a cold action cache, 4 plan replay with a warm cache. Agent thinking time is not simulated; the table says so.
- Metrics per task × mode: wall ms (median of 3), browser ms (sum of step `ms`), tool calls an agent would make (mode 1: one per step; 2: one per page; 3–4: one). Writes `docs/bench.md` (table + date + machine) only with `--write`.

- [ ] **Step 1:** `pnpm bench` runs all tasks/modes and prints the table; mode 2 wall < mode 1 wall on store-listing; mode 4 wall ≤ mode 3 wall.
- [ ] **Step 2:** Implement until it does. **Step 3:** `pnpm test:e2e` still green after the fixtures refactor. **Step 4:** Commit `feat(bench): time-to-done benchmark`.

---

### Task 6: Windows host install

**Files:** modify `packages/cli/src/paths.ts` (`socketPath()` → named pipe on win32), `install/host-manifest.ts` (win32 manifest path `%LOCALAPPDATA%\Kitestring\com.kitestring.bridge.json`, `reg add HKCU\Software\Google\Chrome\NativeMessagingHosts\com.kitestring.bridge /ve /t REG_SZ /d <path> /f` (Chromium: `HKCU\Software\Chromium\NativeMessagingHosts\…`), wrapper `host.cmd`), `install/shim.ts` (`kite.cmd` in `%LOCALAPPDATA%\Kitestring\bin`), `init/agents.ts` (Windows config paths: `%USERPROFILE%\.codex\config.toml`, `%USERPROFILE%\.cursor\mcp.json`, `%USERPROFILE%\.gemini\settings.json`, `%USERPROFILE%\.config\opencode\opencode.json`, Claude via `claude mcp add` unchanged), `host/daemon.ts` (no chmod on pipes; skip unlink of a pipe path), tests with `vi.spyOn(process, "platform", …)`/injected platform and stubbed `execFile`.

- [ ] **Step 1: Failing unit tests:** win32 → pipe path `\\.\pipe\kitestring-<user>`; manifest + `reg add` args exact; `host.cmd` content runs node with the host main; `kite.cmd` content; agent paths. **Step 2:** FAIL. **Step 3:** Implement (darwin/linux behavior byte-identical — existing tests unchanged). **Step 4:** PASS. **Step 5:** Commit `feat(cli): Windows host install and named pipe (untested on Windows)`.

---

### Task 7: Web Store package, README, demo GIF

**Files:** create `scripts/package-store.mjs`, root script `package:store`, `store/{listing.md, privacy.md}`, `e2e/store-shots.spec.ts` (1280×800 screenshots into `store/screenshots/` only with `KITE_UPDATE_DOCS=1`), `apps/bench/gif.ts` (or `e2e/demo.spec.ts`) producing `docs/demo.gif` (side panel + store-listing filled by one batch; frames via `page.screenshot` encoded with `gifenc`, ≤ 3 MB) only with `KITE_UPDATE_DOCS=1`; modify `packages/protocol/src/constants.ts` (`KITE_STORE_EXTENSION_ID = ""`), `install/host-manifest.ts` + `init` (allowed_origins includes the store id when set), `README.md`.

**Interfaces:**
- `package-store.mjs`: runs `plasmo build` (prod), copies `build/chrome-mv3-prod` to a temp dir, deletes `manifest.key`, zips to `dist/kitestring-<version>.zip`, prints the path and size; fails if the zip contains `.map` files or anything outside the build.
- `store/listing.md`: name, summary ≤ 132 chars, description, category, single-purpose statement, one plain justification per permission (`debugger`, `nativeMessaging`, `tabs`, `tabGroups`, `scripting`, `storage`, `sidePanel`, `<all_urls>`). `store/privacy.md`: the extension collects and transmits nothing; it talks only to the local `kite` program on the same computer; plans and the action cache stay on the user's machine.
- README: sections for action cache, remembered tasks (`kite run`, `browser_plan_*`), memory, record → skill, benchmark table (from `docs/bench.md`), Windows status, Store package; demo GIF at the top.

- [ ] **Step 1: Failing test:** a node test for `package-store.mjs` (on a fake build dir) asserts no `key` in the zipped manifest and no `.map`; host-manifest test: allowed_origins has 2 entries when `KITE_STORE_EXTENSION_ID` is set (inject), 1 when empty.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; generate screenshots and GIF (`KITE_UPDATE_DOCS=1`) and view them. **Step 4:** Full gate `pnpm build && pnpm test && pnpm -r typecheck && pnpm test:e2e` green. **Step 5:** Commit `feat: Web Store package, listing, README and demo GIF`.
