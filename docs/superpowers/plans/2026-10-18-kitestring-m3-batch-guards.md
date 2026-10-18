# Kitestring M3 — Batch + Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent fills a long multi-page form (the Chrome Web Store dashboard is the motivating case) in one or two calls instead of one call per field, with uploads working and the page's alerts, cookie walls, popups and redirects handled safely.

**Architecture:** A new `act.batch` RPC runs a list of steps under one tab lock, each step going through the existing FIND → CHECK → ACT → WAIT → VERIFY pipeline with lazy targets, inside a time budget, halting on the rules in the spec. Guards live in the extension background: the alert guard (CDP dialogs), the popup closer (on `blocked`, patterns in page-agent), the tab watcher (adopt opener children) and the domain guard (batch only). File upload is a new action (`act.upload`) using `DOM.setFileInputFiles`, with paths checked by the CLI against a deny list.

**Tech Stack:** As M2 (TypeScript, Plasmo 0.90.5 MV3, CDP via `chrome.debugger`, commander CLI, MCP SDK 1.32, vitest, Playwright).

**Spec:** `docs/superpowers/specs/2026-10-18-kitestring-m3-m6-design.md` (Part A plus §D2, which is binding and overrides Part A where they differ). Parent: `docs/superpowers/specs/2026-10-17-bx-design.md`.

## Global Constraints

- Batch: max 50 steps; `budget_ms` default 40_000, clamped to 5_000..40_000; a step does not start with < 3_000 ms of budget left; each step's cap = `min(ACTION_CAP_MS (15_000), remaining − 1_000)`; step `wait` max 10_000 and clamped to the remaining budget. On step expiry: step `timeout`, halt `time`, `next` = that step's index.
- MCP server passes `budget_ms` from env `KITE_BATCH_BUDGET_MS` on every `browser_batch` call; `kite init` writes `KITE_BATCH_BUDGET_MS=12000` for OpenCode only. CLI `kite batch --budget <ms>`.
- Halt reasons (exact strings): `not_found`, `ambiguous`, `blocked`, `disabled`, `error`, `timeout`, `restricted`, `domain`, `dialog`, `expect`, `risky`, `paused`, `time`. `no_effect` and `skipped` never halt.
- Batch result serialized ≤ 900 KB (truncate diff lines first, then the page brief); batch diff ≤ 40 lines each side; no per-step diffs.
- Risk keywords (case-folded, whole word/phrase, on the resolved target's accessible name): `pay`, `buy`, `purchase`, `place order`, `send`, `delete`, `remove account`, `publish`, `submit for review`, `transfer`, `confirm payment`. Batch `click` only; checked after FIND, before ACT. Single `act.click` is never blocked.
- Dialogs: `alert` → accept; `beforeunload` → accept only during an agent-requested navigation (`goto` step / `page.goto`), else dismiss; `confirm`/`prompt` → the step's `dialog` policy, else dismiss and (in a batch) halt `dialog`.
- Popup closer runs only after CHECK says `blocked`, at most once per step; prefers reject / necessary only / decline, then accept / agree / OK; newsletter modals → close / dismiss / × / ✕ / "No thanks".
- Domain guard: registrable domain (eTLD+1) of the active tab's URL after each step settles must be in {batch start domain, `allow_domains`, domains of this batch's `goto` URLs and `expect.url` values}. `127.0.0.1`/`localhost`/IP hosts compare by full host.
- Upload deny list (CLI side, after `realpath`): under `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kitestring` (`$KITE_HOME`), `~/.config`, `~/Library/Keychains`; basename matching `^\.env`; size > 100 MB (104_857_600 bytes); not a regular file. Error: `BAD_REQUEST: refusing to upload <path>: <reason>`. `KITE_UPLOAD_ALLOW` = colon-separated dirs that override the location rules (not size/type). Activity log records upload basenames only.
- Locks: a batch holds the lock of the tab it is acting on; `switch_tab` releases it and queues for the new tab's lock. Pause is checked before every step.
- Activity: one entry per batch step (method `act.<action>`), with new optional `batch?: number` (same id for all steps of one batch); router does not record `act.batch` itself. Filled values never recorded.
- Zod: protocol/extension stay on `zod ~3.24.4`; CLI MCP schemas use the CLI's zod.
- Commit messages: conventional commits, trailers as in M2.

## Review Focus

1. **A batch arrives while another session's action holds the tab** — the batch queues; queue time counts against its budget; if the budget runs out while queued, it answers `halted: {index: 0, reason: "time"}`, `next: 0`, no step run. Test in Task 6.
2. **User pauses mid-batch** — the running step finishes (or hits its cap); the batch halts `paused` before the next step; `next` points at it. Test in Task 6.
3. **A step moves to a subdomain or an OAuth popup on another domain** — `www.` → `accounts.` same eTLD+1 does not halt; a different registrable domain halts `domain` unless allowed. Test in Tasks 1 and 6.
4. **Upload path is relative, a directory, missing, or a symlink into `~/.ssh`** — relative resolves against the CLI's cwd; directory/missing → BAD_REQUEST; symlink is resolved with `realpath` before the deny check, so it is refused. Test in Task 5.
5. **Huge page diff in a batch** (100+ changed lines) — result stays ≤ 900 KB and valid JSON, diff capped at 40 lines each side. Test in Task 6.

---

## File Structure (new/changed)

```
packages/protocol/src/{batch.ts, risk.ts, domain.ts}          # new: step/result types + validation, risk keywords, eTLD+1
packages/protocol/src/{rpc.ts, results.ts, index.ts}          # act.batch, act.upload; ActionResult.dialogs; ActivityEntry.batch
packages/page-agent/src/{popups.ts, files.ts}                 # new: closer finder, file-input resolution
packages/page-agent/src/index.ts                              # agent methods: closerFor, fileInputFor, hasText
packages/extension/background/{dialogs.ts, batch.ts, upload.ts}   # new
packages/extension/background/{pipeline.ts, sessions.ts, rpc-router.ts, activity.ts}
packages/extension/ui/…                                       # side panel groups batch entries
packages/cli/src/{commands.ts, client/format.ts, client/human.ts}
packages/cli/src/upload-guard.ts                              # new: path resolution + deny list
packages/cli/src/mcp/tools.ts  packages/cli/src/init/agents.ts (or init.ts)
skills/kitestring/SKILL.md, skills/kitestring-e2e-verify/SKILL.md
apps/torture/pages/{alert-box, new-tab-link, oauth-popup, oauth, cookie-wall, newsletter-modal, multi-page-checkout*, file-upload, store-listing}.html
apps/torture/server.ts (POST upload echo not needed; pages read files client-side)
e2e/m3.spec.ts
```

---

### Task 1: Protocol — batch types, risk keywords, registrable domain

**Files:** create `packages/protocol/src/{batch.ts, risk.ts, domain.ts}`, tests `packages/protocol/test/{batch,risk,domain}.test.ts`; modify `rpc.ts` (METHODS += `act.batch`, `act.upload`), `results.ts`, `index.ts` (re-export).

**Interfaces (Produces):**
- `batch.ts`: types exactly as spec §A1 (`BatchParams` incl. `budget_ms?: number`, `Step`, `StepBase`, `Expect`, `HaltReason`, `StepResult` incl. internal `resolved?: {role: string; name: string; within?: string}`, `BatchResult`). Constants `BATCH_MAX_STEPS = 50`, `BATCH_BUDGET_DEFAULT_MS = 40_000`, `BATCH_BUDGET_MIN_MS = 5_000`, `BATCH_STEP_MIN_START_MS = 3_000`, `STEP_WAIT_MAX_MS = 10_000`, `BATCH_RESULT_MAX_BYTES = 900_000`, `BATCH_DIFF_MAX_LINES = 40`. `parseBatchParams(raw: unknown): BatchParams` (zod 3.24 schema; string targets go through `parseTarget` with the step's `within`/`role`; throws `Error` with a path-qualified message such as `steps[2].value: required for fill`). `clampBudget(ms?: number): number`.
- `risk.ts`: `RISK_KEYWORDS` (list from Global Constraints), `isRisky(name: string): boolean` (uses `norm`-equivalent case folding: NFKC, nbsp → space, collapse whitespace, lowercase; whole-word/phrase match).
- `domain.ts`: `registrableDomain(url: string): string` (IP or `localhost` → host; else eTLD+1 using a bundled suffix subset covering at least `co.uk, org.uk, ac.uk, gov.uk, com.au, net.au, co.in, co.jp, com.br, co.nz, github.io, vercel.app, netlify.app, pages.dev, web.app, firebaseapp.com, appspot.com, herokuapp.com, cloudfront.net, blogspot.com`; fallback last two labels). `sameSite(a: string, b: string): boolean`.
- `results.ts`: `ActionResult.dialogs?: DialogEvent[]`, `DialogEvent = {type: "alert"|"confirm"|"prompt"|"beforeunload"; message: string; handled: "accepted"|"dismissed"}`; `ActivityEntry.batch?: number`.

- [ ] **Step 1: Failing tests.**
  - `batch.test.ts`: valid batch parses, `"Save"` → `{text:"Save"}` and `"@e1k2d9"` → `{ref}`; `within` folds into the target; 51 steps → throws `/at most 50 steps/`; fill without value → throws `/steps\[0\]\.value/`; `upload` with empty `files` → throws; unknown action → throws; `wait: 20000` → throws `/at most 10000/`; `clampBudget()` = 40000, `clampBudget(1000)` = 5000, `clampBudget(99999)` = 40000.
  - `risk.test.ts`: `isRisky("Place order")`, `isRisky("Submit for review")`, `isRisky("  PAY now ")`, `isRisky("Delete")` true; `isRisky("Display settings")`, `isRisky("Sender name")`, `isRisky("Save draft")`, `isRisky("Checkout")` false.
  - `domain.test.ts`: `https://www.example.com/a` → `example.com`; `https://accounts.example.co.uk` → `example.co.uk`; `http://127.0.0.1:4173/x` → `127.0.0.1`; `http://localhost:9/` → `localhost`; `https://foo.github.io` → `foo.github.io`; `sameSite("https://a.x.com","https://b.x.com")` true; `sameSite("http://127.0.0.1:1","http://localhost:1")` false (Review Focus 3).
- [ ] **Step 2:** `pnpm --filter @kitestring/protocol test` → FAIL (modules missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests PASS; `pnpm -r typecheck` clean.
- [ ] **Step 5:** Commit `feat(protocol): batch types, risk keywords, registrable domain`.

---

### Task 2: Alert guard

**Files:** create `packages/extension/background/dialogs.ts`, test `packages/extension/test/dialogs.test.ts`; modify `cdp.ts` (ensure `Page.enable` before dialogs; already enabled for Watch — verify), `pipeline.ts` (single actions report dialogs; `goto` marks agent navigation); torture `apps/torture/pages/alert-box.html`; `e2e/m3.spec.ts` (new file).

**Interfaces (Produces):**
- `dialogs.ts`: `type DialogPolicy = "accept" | "dismiss"`; `watchDialogs(tabId: number, opts: { policy?: DialogPolicy; navigating?: () => boolean }): DialogWatch` where `DialogWatch = { events: DialogEvent[]; stop(): void }`. Listens to `Page.javascriptDialogOpening` via `onEvent`, answers with `Page.handleJavaScriptDialog {accept}` per Global Constraints (prompt accepted with `promptText: ""`), records each event. Also a background-wide default handler `installDialogGuard()` for attached tabs with no active watch (alerts accepted, everything else dismissed) so a dialog never wedges a tab between actions.
- `pipeline.ts`: `begin()` starts a `DialogWatch` for the run (policy from the caller; single actions: none); `finish()`/`early()` copy `events` into `ActionResult.dialogs` when non-empty. Export for Task 6: `Run` gains `dialogs: DialogWatch`.
- `alert-box.html`: button "Show alert" (`alert("Hello")` then sets step1), button "Delete everything" (`if (confirm("Really delete?")) __result="WRONG:deleted"; else __result="kept"`), button "Rename" (`prompt("New name")` → `__result = "renamed:" + value` or `"rename-cancelled"`).

- [ ] **Step 1: Failing unit test** (`dialogs.test.ts`, chrome/cdp mocked as in `capped.test.ts`): alert → `handleJavaScriptDialog {accept:true}`; confirm with no policy → `{accept:false}` and event `handled:"dismissed"`; confirm with policy `accept` → accepted; beforeunload with `navigating()` true → accepted, false → dismissed.
- [ ] **Step 2: Failing e2e** (`e2e/m3.spec.ts`, `alert-box`): `kite click "Show alert"` → `✓ done` within 3 s and output contains `dialog alert "Hello" accepted`; `kite click "Delete everything"` → `__result === "kept"` and output names the dismissed confirm; `kite --json click "Rename"` → `dialogs[0].type === "prompt"`.
- [ ] **Step 3:** FAIL. **Step 4:** Implement; `client/format.ts` prints `! dialog <type> "<message>" <handled>` per dialog. **Step 5:** PASS (unit + e2e + existing e2e). **Step 6:** Commit `feat(extension): alert guard for JS dialogs`.

---

### Task 3: Tab watcher — adopt opened tabs, popups, switch helpers

**Files:** modify `packages/extension/background/sessions.ts`, `pipeline.ts`, test `packages/extension/test/sessions.test.ts`; torture `new-tab-link.html`, `new-tab-target.html`, `oauth-popup.html`, `oauth.html`; e2e in `m3.spec.ts`.

**Interfaces (Produces):**
- `sessions.ts`: a global `chrome.tabs.onCreated` listener adopts any tab whose `openerTabId` is owned by a session (not only during an action), recording `opener: Map<tabId, openerTabId>`; tabs in another window are owned but not grouped. `chrome.tabs.onRemoved`: drop the tab; if it was a session's active tab and has a live opener in the session, the opener becomes active. New exports: `newestAdopted(s: Session, since?: number): number | undefined` (most recently adopted tab id, optionally adopted after epoch ms `since`), `openerOf(s: Session, tabId: number): number | undefined`.
- Torture: `new-tab-link` has `<a target="_blank" href="/new-tab-target">Open report</a>`; `new-tab-target` has button "Confirm report" → `__result="report-confirmed"` and beacons it to `/__last-result`. `oauth-popup` (served at `127.0.0.1`) button "Sign in with Kite" → `window.open("http://localhost:<same port>/oauth?return=<origin>")`; `oauth` has button "Allow" → `opener.postMessage("granted", returnOrigin); window.close()`; `oauth-popup` sets `__result="signed-in"` on the message.

- [ ] **Step 1: Failing unit test:** tab created with opener owned by session `a` → owned by `a`; closing active popup → opener active again; `newestAdopted` returns the latest.
- [ ] **Step 2: Failing e2e:** `new-tab-link`: `kite click "Open report"` lists `⧉ new tab <id>`; `kite tab list` includes it; `kite tab use <id>` + `kite click "Confirm report"` → `/__last-result` = `report-confirmed`. `oauth-popup`: click "Sign in with Kite", `kite tab use <popup id>`, `kite click Allow` → popup closes, session active tab is the opener again (`kite tab list` marks it), opener `__result === "signed-in"`.
- [ ] **Step 3:** FAIL. **Step 4:** Implement. **Step 5:** PASS. **Step 6:** Commit `feat(extension): adopt tabs and popups opened by session tabs`.

---

### Task 4: Popup closer (cookie walls, newsletter modals)

**Files:** create `packages/page-agent/src/popups.ts`, tests `packages/page-agent/tests/popups.spec.ts` (+ fixtures in the harness style of `check.spec.ts`); modify `page-agent/src/index.ts` (agent method `closerFor(ref: string): { ref: string; line: string; kind: "cookie" | "newsletter" } | null` — given the blocked target's ref, finds the covering overlay at its center and a closer control within it), `extension/background/pipeline.ts` (on `blocked`: call `closerFor`, click it through the same input path, settle, re-run CHECK once; record in `ActionResult.closedPopups?: string[]` — add the optional field to `results.ts`); torture `cookie-wall.html`, `newsletter-modal.html`, `covered-by-overlay.html`; `e2e/m1.spec.ts` + `apps/torture/expected.md` (covered-by-banner row).

**Interfaces:**
- Patterns per Global Constraints. Cookie overlay detection: the covering element or an ancestor matches `#onetrust-banner-sdk, #onetrust-consent-sdk, #CybotCookiebotDialog, #didomi-host, .qc-cmp2-container, #truste-consent-track, #usercentrics-root, [id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], [aria-label*=cookie i]`. Newsletter: overlay is `role=dialog`/`[aria-modal=true]` or `position: fixed` covering ≥ 30% of the viewport, and its text matches `/newsletter|subscribe|sign up|discount|% off/i`. Closer buttons are matched by accessible name (normalized) in the order given; never a button whose name `isRisky()`.
- The closer never runs for a cover that matches neither pattern. The M1 `covered-by-banner` page (`role=dialog aria-label="Cookie banner"`, button "Accept") now auto-closes: update its M1 e2e and `expected.md` row to `kite click Continue` → `✓ done` with `closed popup cookie "Accept"`. Keep the `blocked` path covered with a new torture page `covered-by-overlay` (fixed full-screen `role=dialog aria-label="Scheduled maintenance"`, text "Maintenance tonight", button "OK"): `kite click Continue` → `blocked`, then `kite click OK`, then `kite click Continue` → `continued`.
- Torture: `cookie-wall` — form "Newsletter preferences" with field Email + button "Continue" covered by a OneTrust-style banner with buttons "Accept all" (sets `consent=all`) and "Reject all" (sets `consent=none`); `__result = "continued:" + consent`. `newsletter-modal` — after 500 ms a fixed modal "Get 10% off — subscribe to our newsletter" with a `×` button (aria-label "Close") and "Subscribe" button (sets `WRONG:subscribed`); page button "Read article" → `__result="read"`.

- [ ] **Step 1: Failing page-agent tests:** OneTrust fixture → closer is "Reject all", kind `cookie`; banner with only "Accept" → "Accept"; newsletter fixture → "Close" (not "Subscribe"); generic fixed div "Maintenance tonight" with "OK" → `null`; banner whose only button is "Delete account" → `null`.
- [ ] **Step 2: Failing e2e:** `kite click Continue` on `cookie-wall` → `✓ done`, output lists `closed popup cookie "Reject all"`, `__result === "continued:none"`; `newsletter-modal`: wait 700 ms then `kite click "Read article"` → `__result === "read"`.
- [ ] **Step 3:** FAIL. **Step 4:** Implement; format line `⨯ closed popup <kind> "<button>"`. **Step 5:** PASS incl. M1 e2e. **Step 6:** Commit `feat: popup closer for cookie walls and newsletter modals`.

---

### Task 5: File upload

**Files:** create `packages/cli/src/upload-guard.ts`, test `packages/cli/test/upload-guard.test.ts`; create `packages/page-agent/src/files.ts` (+ spec), `packages/extension/background/upload.ts`; modify `pipeline.ts` (new action kind `upload`), `rpc-router.ts` (`act.upload {target, files: string[]}`; activity target = `"<target>" ← a.zip, b.png` basenames), `commands.ts` (`kite upload <target> <files...> [--within] [--role]`), `mcp/tools.ts` (`browser_upload {target, files: string[], within?, role?}`), `client/human.ts`; torture `file-upload.html`; e2e.

**Interfaces:**
- `upload-guard.ts`: `resolveUploads(paths: string[], opts: { cwd: string; home: string; kiteHome: string; env: NodeJS.ProcessEnv }): string[]` — resolve relative to `cwd`, `realpathSync`, `statSync` must be a regular file ≤ 104_857_600 bytes, deny list from Global Constraints, `KITE_UPLOAD_ALLOW` override; throws `KiteError("BAD_REQUEST", "refusing to upload <path>: <reason>")` with reason one of `not found`, `not a regular file`, `larger than 100 MB`, `sensitive location`. Used by both CLI `upload`/`batch` and MCP `browser_upload`/`browser_batch` before calling the RPC.
- `files.ts` (page-agent): `fileInputFor(el: Element): HTMLInputElement | null` — el itself if `input[type=file]`; else `label[for]`/wrapping label target; else nearest container (walk up ≤ 5 ancestors) holding 1..3 file inputs → the one with smallest DOM distance; else null. Agent method `fileInputFor(ref) → { ref: string; multiple: boolean } | null`.
- `upload.ts` (extension): `setFiles(tabId, inputRef | null, files, clickAt?)`: with an input: resolve node via `Runtime.evaluate` on the agent's element → `DOM.requestNode`/`DOM.describeNode` → `DOM.setFileInputFiles {files, backendNodeId}`; without: `Page.setInterceptFileChooserDialog {enabled:true}`, click target, await `Page.fileChooserOpened` (≤ 5 s), `DOM.setFileInputFiles {files, backendNodeId: event.backendNodeId}`, and always disable interception in `finally`. > 1 file to a non-`multiple` input → BAD_REQUEST. VERIFY: agent reads `input.files` names; mismatch → `error`.
- Torture `file-upload`: (a) plain `<input type=file id=a>` labelled "Extension zip"; (b) hidden input behind `<button>Choose screenshots</button>` (`multiple`) that calls `input.click()`; (c) a drop zone div "Drop icon here" whose click handler creates a detached `input[type=file]` and clicks it (no associated input → chooser fallback). `__result` = `JSON.stringify({a:[names], b:[names], c:[names]})` once all three have files.

- [ ] **Step 1: Failing unit tests** (`upload-guard.test.ts`, temp dirs as fake home): relative path resolves against `cwd`; missing → `not found`; directory → `not a regular file`; `~/.ssh/id_ed25519` → `sensitive location`; symlink in cwd pointing into fake `~/.ssh` → `sensitive location` (Review Focus 4); `.env.local` anywhere → `sensitive location`; file in `~/.config/x` allowed when `KITE_UPLOAD_ALLOW` contains `~/.config/x`'s dir; 101 MB sparse file → `larger than 100 MB`.
- [ ] **Step 2: Failing page-agent tests** for `fileInputFor` (label, wrapping container, ambiguous container with 4 inputs → null).
- [ ] **Step 3: Failing e2e:** `kite upload "Extension zip" <tmp>/kite.zip`, `kite upload "Choose screenshots" <tmp>/s1.png <tmp>/s2.png`, `kite upload "Drop icon here" <tmp>/icon.png` → `__result` equals `{"a":["kite.zip"],"b":["s1.png","s2.png"],"c":["icon.png"]}`; `kite upload "Extension zip" ~/.ssh/x` exits 1 with `refusing to upload`; `kite activity` shows `← kite.zip`, never the full path.
- [ ] **Step 4:** FAIL. **Step 5:** Implement. **Step 6:** PASS. **Step 7:** Commit `feat: file upload with a sensitive-path deny list`.

---

### Task 6: Batch engine

**Files:** create `packages/extension/background/batch.ts`, test `packages/extension/test/batch.test.ts`; modify `pipeline.ts` (refactor so steps can run inside a lock the caller holds), `rpc-router.ts` (`act.batch` handler, skip router-level recording for it), `activity.ts` (`record` accepts `batch`); torture pages added in Task 8 are not needed here — use existing pages plus `alert-box`, `cookie-wall`, `new-tab-link` in e2e.

**Interfaces:**
- `pipeline.ts` refactor (behavior of existing single actions unchanged):
  - `capped(tabId, body, opts?: { capMs?: number; holdsLock?: boolean })` — `capMs` default `ACTION_CAP_MS`; `holdsLock: true` skips `withTabLock` (the caller holds it) but keeps the cap/expiry semantics.
  - `runStep(s: Session, tabId: number, action: Action | { kind: "goto"; url: string }, opts: { capMs: number; dialog?: DialogPolicy; beforeAct?: (found: { ref: string; line: string; role: string; name: string }) => HaltReason | null }): Promise<ActionResult & { resolved?: { role: string; name: string; within?: string }; halt?: HaltReason }>` — runs one step with `holdsLock: true`. `beforeAct` is called after CHECK passes and before input is dispatched (used for `risky`). Page agent `find` result gains `role` and `name` (and `within` = nearest landmark name) for this.
  - `Action` gains `{ kind: "upload"; target: Target; files: string[] }` (from Task 5).
- `batch.ts`: `runBatch(s: Session, params: BatchParams, opts: { batchId: number; record: (e) => void }): Promise<BatchResult>`:
  - Acquire `withTabLock(startTab, …, {signal})` with the abort signal tied to the budget; snapshot `before` (for the batch diff) and start domain.
  - For each step: `assertNotPaused()` (→ halt `paused`); remaining budget check (< 3_000 → halt `time`, `next = i`); `wait` → poll agent `find` every 200 ms until found or `min(wait, remaining−1000)`; `if_present` + not found → `skipped`; `switch_tab` → `newestAdopted`/`openerOf`/explicit id must be owned → release lock, acquire new tab's lock, set active; `wait` action → sleep `ms`, then `expect`; others → `runStep` with `capMs = min(15_000, remaining − 1_000)`, `beforeAct` = risky check for clicks.
  - After each step: map status → halt per Global Constraints; domain guard on active tab URL; `expect` (`{text}` → new agent method `hasText(text): boolean` case-folded substring of `document.body.innerText`; `{url}` → substring, or regex when wrapped in `/…/`); dialog events with type confirm/prompt/beforeunload and no step `dialog` → halt `dialog`.
  - Record one activity entry per step that ran (`batch: batchId`).
  - Result: per spec §A1; diff from `before` vs final snapshot capped at 40 lines; aggregate `dialogs`, `closedPopups`, `newTabs`; `candidates`/`blockedBy` from the halting step; enforce 900 KB.
- Router: `act.batch` → `parseBatchParams` (BAD_REQUEST on error) → `runBatch`. Batch ids from a module counter seeded with `Date.now()`.

- [ ] **Step 1: Failing unit tests** (`batch.test.ts`, `runStep`/agent/cdp mocked): three ok steps → `ok:true`, 3 step results; second step `not_found` → `halted {index:1, reason:"not_found"}`, `next:1`, third not run; `if_present` not found → `skipped`, continues; `no_effect` continues; risky click → `beforeAct` halts `risky` and no input dispatched; budget 5_000 with steps that each take 2_500 → halt `time` with `next` = first unstarted; step that expires → step `timeout`, halt `time`, `next` = its own index (D2 #2); pause flipped during step 1 → halt `paused` at index 1; lock held by another holder until budget expiry → `halted {index:0, reason:"time"}`, `next:0` (Review Focus 1); 200-line diff → result diff 40/40 and `JSON.stringify(result).length ≤ 900_000` (Review Focus 5); domain change to other eTLD+1 → halt `domain`; same eTLD+1 subdomain → continues.
- [ ] **Step 2: Failing e2e** (`m3.spec.ts`, via `kite --json batch -` fed through stdin — add a `kiteStdin(input, ...args)` helper to `e2e/fixtures.ts`): `basic-form` in one batch (fill Name, fill Email, click Submit) → `ok:true`, `__result === "submitted:Ada:ada@x.io"`; `alert-box` batch (Show alert, Delete everything) → halts `dialog` at index 1, `dialogs` lists both; `cookie-wall` batch (fill Email, click Continue) → ok, `closedPopups` non-empty; `new-tab-link` batch (click "Open report", `switch_tab new`, click "Confirm report") → ok; `kite pause` sent while a 3-step `slow-button` batch runs → halts `paused` (Review Focus 2); activity shows one entry per step sharing a `batch` id.
- [ ] **Step 3:** FAIL. **Step 4:** Implement. **Step 5:** PASS (unit, e2e, all prior e2e — the refactor must not change single-action behavior). **Step 6:** Commit `feat(extension): act.batch with lazy targets, halt rules and time budget`.

---

### Task 7: Batch surfaces — CLI, MCP, init budget, side panel, skills

**Files:** modify `packages/cli/src/commands.ts` (`kite batch <file|-> [--budget <ms>] [--allow-domain <d>...]`), `client/format.ts` (`formatBatch`), `client/human.ts`, `mcp/tools.ts` (`browser_batch`), `init/*` (OpenCode MCP env adds `KITE_BATCH_BUDGET_MS=12000`; idempotent update of existing entries), `doctor/doctor.ts` (no change unless entry comparison needs the new env), UI side panel (`ui/…`: consecutive entries with the same `batch` render as one group header `batch · N steps` with the steps nested, collapsed by default when > 5), skills `skills/kitestring/SKILL.md` (Batching section) and `skills/kitestring-e2e-verify/SKILL.md` (examples use batch), tests `packages/cli/test/{format,mcp,init,cli}.test.ts`, `e2e/ui.spec.ts`.

**Interfaces:**
- CLI input: file or stdin containing either a `Step[]` array or `{steps, allow_domains?, budget_ms?}`; `--budget`/`--allow-domain` override. Upload steps' `files` go through `resolveUploads` (Task 5) before sending. Exit code 0 iff `ok`.
- `formatBatch(r: BatchResult): string` — one line per step `✓ 1 fill "Name"` / `· 2 skipped "Accept cookies"` / `✗ 3 click "Pay": risky`, then `halted at step N (<reason>): <detail>` and `resume with steps from N` when `next` is set, then dialogs/closed popups/new tabs lines, diff (`+`/`-`), `page: …`. Step numbers are 1-based in human output, 0-based in JSON.
- `browser_batch` shape: `steps` (array of a zod discriminated union on `action` mirroring `Step`, targets as strings + `within`/`role`), `allow_domains?: string[]`. Description: `Prefer this over single actions when you know several steps ahead (forms, multi-page flows). Steps run in order with lazy targets; the batch stops at the first problem and tells you which step to resend from.` Passes `budget_ms` from `KITE_BATCH_BUDGET_MS` when set.
- Skill text (Batching section, ≤ 40 lines): snapshot once → send every predictable step in one batch; `if_present` for optional popups; `expect` after steps that change page; `wait` for content that appears late; after a halt read `halted`, fix that step, resend `steps.slice(next)`; risky steps (pay, place order, submit for review, delete, …) halt by design — do them as a single click only when the user asked for it.

- [ ] **Step 1: Failing tests:** `format.test.ts` golden output for ok, halted-risky, halted-time results; `mcp.test.ts`: `listTools` includes `browser_batch` (16 tools now plus `browser_upload` = 17), call forwards `act.batch` with parsed targets and `budget_ms: 12000` when env set; `init.test.ts`: OpenCode entry gains `KITE_BATCH_BUDGET_MS`, others don't, rerun is a no-op; `cli.test.ts`: `kite batch -` reads stdin; malformed JSON → exit 2 with `invalid batch: …`; `ui.spec.ts`: a 3-step batch renders one group with 3 steps.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Re-run the skills pressure check from `skills/TESTING.md` for the batching section (one subagent run is enough; record result in the commit body). **Step 6:** Commit `feat: kite batch, browser_batch, batch-aware side panel and skills`.

---

### Task 8: Flow pages and M3 exit test

**Files:** torture `multi-page-checkout.html`, `multi-page-checkout-shipping.html`, `multi-page-checkout-review.html`, `multi-page-checkout-done.html`, `store-listing.html`; `apps/torture/expected.md` (all M3 pages); `e2e/m3.spec.ts` (exit test block); `README.md` (Batching, Guards, Upload sections; upload deny list stated).

**Interfaces:**
- `multi-page-checkout`: cart page (button "Proceed to shipping", a cookie banner covering it on first load) → shipping form (Full name, Address, City, Country select, "Continue to payment") → review page (shows the entered data, "Place order") → done page sets `__result = "order:" + name + ":" + country` and beacons it.
- `store-listing`: tabs "Store listing" (Title, Summary ≤ 132 chars with counter, Description textarea, Category select, Language select), "Privacy" (single-purpose textarea; one justification textarea per permission `debugger`, `nativeMessaging`, `tabs`, `host permissions`; radio "Does not collect user data"), "Package" (upload "Extension zip", upload "Screenshots" multiple). Buttons "Save draft" (validates all fields; on success shows "Draft saved" and sets `__result = "saved:" + JSON.stringify(summary of values + file names)`) and "Submit for review" (`__result = "submitted"`). Switching tabs is a click on the tab (role=tab) and the panel's fields are hidden when not selected (lazy targets must find them after the tab click).

- [ ] **Step 1: Failing exit e2e (the M3 milestone gate):** each of `alert-box`, `new-tab-link`, `oauth-popup` (with `allow_domains: ["localhost"]`), `cookie-wall`, `newsletter-modal` (the closer handles the late modal; no `if_present` step needed), `multi-page-checkout` reaches its `__result` in **≤ 3 `kite batch` calls** (count asserted); `multi-page-checkout` halts `risky` on "Place order" and the test finishes with one `kite click "Place order"`; `store-listing` is filled and saved in **≤ 2 batches**, then a batch containing "Submit for review" halts `risky` before acting (`__result` still `saved:…`), then single `kite click "Submit for review"` → `submitted`.
- [ ] **Step 2:** FAIL (pages missing). **Step 3:** Implement pages, `expected.md`, README sections. **Step 4:** PASS: `pnpm build && pnpm test && pnpm typecheck && pnpm test:e2e` all green. **Step 5:** Commit `test(e2e): M3 exit — flows complete in ≤ 3 batches`.
