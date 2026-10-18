# Kitestring M3 (Batch + Guards) and M6 (Speed + Launch): Design

Date: 2026-10-18
Status: Draft for review
Parent spec: `docs/superpowers/specs/2026-10-17-bx-design.md` (§5, §6, §7, §10, §13). This document refines M3 and M6 and overrides the parent where they differ.

## 1. Why

The user tried to publish an extension on the Chrome Web Store with an agent driving Chrome through Kitestring. It was sluggish. The dashboard is a long multi-tab form (listing text, category, language, per-permission privacy justifications, screenshots, the extension zip, Save, Submit), and the agent filled **one field per turn**, re-reading the page between turns. Every turn costs a full round trip through the agent's large model (seconds each). The browser side is already fast: no screenshots, deterministic element ranking.

So the speed problem is **agent turns**, not page work. M3 cuts turns per task (batching). M6 cuts model calls on repeat tasks to zero or near zero (cached plans, a cheap fast model for `kite do`).

Success, in the user's terms: the Web Store listing page gets filled in a couple of agent turns instead of dozens, and doing it a second time is several times faster again.

## 2. Goals, non-goals, anti-goals

Goals
- M3: `batch` RPC + CLI + MCP tool; always-on guards (alert, popup closer, tab watcher, domain guard); **file upload** (pulled forward from M4 so the Web Store flow works end to end).
- M6: action cache, site memory (stored plans), `kite do "<intent>"` on DeepSeek V4.1 Flash, record → skill, benchmark harness, Windows host install, Web Store package, README + demo GIF.

Non-goals
- Side-panel human confirm for risky clicks, secret-field block, captcha/login detection, injection flagging, iframes/shadow DOM/custom widgets (all stay M4).
- Submitting to the Chrome Web Store, publishing to npm, pushing to any remote. Claude prepares; the user publishes.
- Jev integration (unverified product; `kite do`'s model client is pluggable enough to try it later).
- `browser_do` MCP tool (the MCP call bound is 45 s; `kite do` runs can be longer). CLI only in M6.
- Running or testing on Windows (code and unit tests only).

Anti-goals (failure even if it "works")
- A batch that keeps clicking after the page went somewhere unexpected.
- An agent able to upload `~/.ssh/id_ed25519` to a website because a page told it to.
- A batch or `kite do` run that clicks "Pay", "Delete", "Publish" or "Submit for review" without the agent (and, in M4, the human) explicitly deciding to.
- Page content silently leaving the machine. `kite do` sends page snapshots to DeepSeek; that must be stated wherever `kite do` is documented and printed once on first use.
- A batch call that outlives the agent's tool timeout (Codex: 60 s) and is reported as a failure while still running.

## 3. Constraints (inherited, binding)

- MCP call bound 45 s (`packages/cli/src/mcp`), Codex tool timeout 60 s, OpenCode timeout 15000 ms (unchanged ruling from M2: OpenCode users get shorter batches).
- Per-action cap `ACTION_CAP_MS = 15_000`, tab FIFO lock `withTabLock`, pause switch (`assertNotPaused`) checked before every step.
- Activity ring (200 entries) records every action; filled values are never recorded.
- No TCP port; socket `~/.kitestring/kite.sock` mode 0600.
- Native messaging host → Chrome ≤ 1 MB per message: batch results must stay compact.
- Node ≥ 22.12, pnpm workspaces, Plasmo 0.90.5, zod 3.x, vitest, Playwright e2e against `apps/torture`.

---

# Part A — M3: Batch + Guards

## A1. `batch` RPC

New method `act.batch` (protocol `METHODS`), params:

```ts
interface BatchParams {
  steps: Step[]                 // 1..50
  allow_domains?: string[]      // extra registrable domains the domain guard accepts
  tab?: number                  // default: session active tab
}

type Step = StepBase & (
  | { action: "goto"; url: string }
  | { action: "click"; target: string | Target }
  | { action: "fill"; target: string | Target; value: string }
  | { action: "select"; target: string | Target; value: string }
  | { action: "press"; key: string }
  | { action: "scroll"; direction: "up" | "down"; px?: number }
  | { action: "upload"; target: string | Target; files: string[] }
  | { action: "switch_tab"; to: "new" | "opener" | number }
  | { action: "wait"; ms?: number; expect?: Expect }   // pure wait / assertion step
)

interface StepBase {
  wait?: number                 // ms to wait for the target to appear (polls find), max 10_000
  expect?: Expect               // checked after the step settles
  if_present?: boolean          // target missing → step "skipped", batch continues
  within?: string; role?: string// narrow a text target (same as single actions)
  dialog?: "accept" | "dismiss" // policy for a dialog this step triggers (overrides guard default)
}
type Expect = { text: string } | { url: string }   // text: substring of page text; url: substring or /regex/
```

Targets are **lazy**: each step resolves its target only when it runs, through the existing FIND → CHECK → ACT → WAIT → VERIFY pipeline (`runAction`). Strings use `parseTarget` (a ref like `@e1k2d9`, else visible text/label).

Execution: one tab lock for the whole batch (other sessions' actions on that tab queue behind it; this keeps steps atomic as a sequence). Pause is checked before every step; a pause mid-batch halts with reason `paused`.

### Halt rules

The batch stops at the first step that ends in any of these and returns everything so far:

| Reason | When |
|---|---|
| `not_found` | target missing after `wait` (and not `if_present`) |
| `ambiguous` | FIND ambiguous (candidates included) |
| `blocked` | still covered after the popup closer had its one try (A3) |
| `disabled` | target disabled |
| `error` / `timeout` / `restricted` | pipeline status |
| `domain` | step landed on a registrable domain not in {batch start domain, `allow_domains`, domains of any `goto` URL or `expect.url` in this batch} |
| `dialog` | a confirm/prompt/beforeunload dialog opened and the step had no `dialog` policy (the guard dismissed it; text reported) |
| `expect` | `expect` failed after settle |
| `risky` | step is a click whose target text matches the risk keyword list (A6) |
| `paused` | user paused Kitestring |
| `time` | batch wall clock reached `BATCH_CAP_MS` |

`no_effect` does **not** halt (reported per step; many form clicks legitimately change nothing visible). `if_present` steps whose target is missing are `skipped`, not halted.

### Time budget

`BATCH_CAP_MS = 40_000` total (under the 45 s MCP bound). A step does not start if fewer than 3 s remain; the batch halts with `time` and reports `next: <index>` so the agent resends `steps.slice(next)`. A step already running keeps its own 15 s cap; the 40 s budget is checked between steps, plus a hard answer at 44 s using the same expiry mechanism as `capped` (`Progress.expired`).

### Result

```ts
interface BatchResult {
  ok: boolean                    // true iff every step ran (done/no_effect/skipped)
  steps: StepResult[]            // one per step that ran or halted
  halted?: { index: number; reason: HaltReason; detail?: string }
  next?: number                  // first step not run, when halted
  diff: Diff                     // page at batch start vs end, capped at 40 lines each
  navigation?: { url: string; title: string }
  newTabs?: number[]
  dialogs?: { type: string; message: string; handled: "accepted" | "dismissed" }[]
  closedPopups?: string[]        // descriptions of overlays the closer dismissed
  candidates?: Candidate[]       // for an ambiguous halt
  blockedBy?: string
  page: string                   // brief of the final page
}
interface StepResult { i: number; action: string; target?: string; status: Status | "skipped"; detail?: string; ms: number }
```

Per-step diffs are dropped (only the batch diff is returned) to keep results small; the halted step's detail carries what the agent needs. The serialized result is truncated to fit 900 KB (diff lines first, then page brief).

Activity log: one entry per step (method `act.<action>`, as single actions today), plus nothing extra for the batch wrapper; the side panel feed groups consecutive entries with the same batch id (new optional `batch?: number` on `ActivityEntry`).

## A2. Surfaces

- CLI: `kite batch <file.json|->` (reads `{steps, allow_domains?}` or a bare steps array from a file or stdin). Human output: one line per step (`✓ 3 fill "Summary"`), then the halt line and final page brief, in the existing `client/format.ts` style. `--json` prints the raw result.
- MCP: `browser_batch` with a zod schema mirroring `Step`; description leads with "Prefer this over single actions when you know several steps ahead (forms, multi-page flows)."
- Skills: `kitestring` skill gains a "Batching" section: snapshot once, send every step you can predict as one batch, use `if_present` for optional popups, `expect` to confirm page transitions, and resend from `next` after a halt. The e2e-verify skill uses batch in its examples.

## A3. Guards

All live in the extension background and are on for every session tab Kitestring has attached to.

**Alert guard.** `Page.javascriptDialogOpening` handled via `Page.handleJavaScriptDialog`:
- `alert` → accept.
- `beforeunload` → accept when the current step is a `goto`/navigation the agent asked for; otherwise dismiss.
- `confirm` / `prompt` → the step's `dialog` policy if given; otherwise **dismiss** (safe default: a confirm usually guards a destructive action) and the batch halts with `dialog`.
Every dialog is reported in the result (`dialogs`) and in the activity log. Single actions (`act.click` etc.) get the same guard; the dialog is reported in `ActionResult` (new optional `dialogs` field) and the action returns normally instead of hanging until the cap, which is today's behavior.

**Popup closer.** Runs only when CHECK reports `blocked` (not continuously, so it never surprises the user mid-browse). Given the covering element, the closer looks for a known pattern within that overlay:
1. Cookie consent: known CMP containers (OneTrust, Cookiebot, Didomi, Quantcast, TrustArc, Usercentrics, generic `[id*=cookie i], [class*=consent i]`) → click the button whose name matches **reject / necessary only / decline** first, then **accept / agree / OK** if no reject exists. My call: prefer reject, since this is the user's real browser profile.
2. Newsletter/promo modal: `role=dialog` or fixed overlay containing subscribe/newsletter/sign up/discount text → its close control (`aria-label` close/dismiss, text `×`/`✕`/"No thanks").
After one closer click the step re-runs CHECK once. Still blocked → halt `blocked`. Closed popups are listed in `closedPopups`. The pattern list lives in `packages/page-agent/src/popups.ts` so it is unit-testable against fixtures.

**Tab watcher.** Tabs/popups opened by a session tab (`openerTabId`, already watched by `Watch.newTabs`) are **adopted into the session** (ownership + tab group when in the same window; popup windows are owned but ungrouped). They do not halt a batch. `switch_tab {to:"new"}` makes the most recently adopted tab active (waits up to `wait` ms for one to appear); `"opener"` returns to the tab that opened the current one. Closed popups (OAuth completing) are dropped from the session and, if active, the active tab falls back to the opener.

**Domain guard.** Batch-only (single actions are already one-step decisions by the agent). Uses registrable domain (eTLD+1) via a small bundled public-suffix subset plus a fallback of the last two labels. Lookalike detection is M4.

## A4. File upload

New single action `act.upload` (`kite upload <target> <file...>`, MCP `browser_upload`) and batch step `upload`.

- Paths are resolved to absolute paths **by the CLI/MCP process** (relative to its cwd), checked to exist and be regular files, and sent to the extension. The extension sets them with CDP `DOM.setFileInputFiles` on the resolved `input[type=file]`; Chrome reads the files itself.
- Target resolution: if the target resolves to an `input[type=file]`, use it. If it resolves to something else (a styled "Browse"/"Upload" button or drop zone), use, in order: the input associated by `<label for>` or wrapping label, a file input inside the same nearest container with ≤ 3 file inputs (nearest by DOM distance), else fall back to `Page.setInterceptFileChooserDialog` + click the target + answer the chooser with the files. Not resolvable → `not_found` with detail "no file input near target".
- VERIFY: read back `input.files.length` and names; mismatch → `error`.
- **Safety (my call):** the CLI refuses paths under `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kitestring`, `~/.config`, `~/Library/Keychains`, any `.env*` file, and any file > 100 MB, with error `BAD_REQUEST: refusing to upload <path>: sensitive location`. `KITE_UPLOAD_ALLOW` (colon-separated dirs) can override the deny list for a specific directory. Every upload is in the activity log with **file names only** (no paths beyond basename).
- Multiple files only when the input has `multiple`; otherwise > 1 file → `BAD_REQUEST`.

## A5. Torture pages and exit test

New pages in `apps/torture/pages` (each sets `window.__result` like existing pages):
- `alert-box` (alert, then confirm guarding a delete, then prompt)
- `new-tab-link` (target=_blank link; task finishes in the new tab)
- `oauth-popup` (window.open to a fake `/oauth` route on a second port-distinct host alias, which posts back and closes)
- `cookie-wall` (CMP-style banner covering the form, with Accept and Reject)
- `newsletter-modal` (delayed modal over the page)
- `multi-page-checkout` (cart → shipping → payment-review → done; "Place order" button)
- `file-upload` (plain input, hidden input behind a styled button, drop zone with chooser, `multiple`)
- `store-listing` (Web-Store-like: three tabs—Listing, Privacy, Package—with text fields, category select, per-permission justification textareas, screenshot + zip uploads, Save draft, Submit for review)

Exit test (Playwright e2e, real CLI): alert-box, new-tab-link, oauth-popup, cookie-wall, newsletter-modal, multi-page-checkout each complete in **≤ 3 batches**; `store-listing` is filled and saved in **≤ 2 batches**, and its "Submit for review" step halts with `risky` (the test then sends that click as a single `act.click` to finish). The same applies to "Place order" in `multi-page-checkout`; the follow-up single click does not count as a batch. Upload deny list unit-tested.

## A6. Risk keywords (stopgap until M4)

A batch `click` halts with `risky` **before acting** when the resolved target's accessible name matches (case-folded, whole word): pay, buy, purchase, place order, send, delete, remove account, publish, submit for review, transfer, confirm payment. Single `act.click` is not blocked (the agent decided that click alone). This is deliberately crude; M4 replaces it with the classifier and side-panel confirm. Keyword list lives in `packages/protocol/src/risk.ts`.

---

# Part B — M6: Speed + Launch

## B1. Action cache

Purpose: skip FIND's ranking and its scroll-and-retry loop when the same target on the same kind of page was resolved before.

- Key: `origin + pathPattern + normalized target text + role? + within?`. `pathPattern` replaces numeric segments, UUIDs, and long hex/base64 ids with `*`.
- Value: locator chain `{ ref, role, name, landmarkPath, cssPath, nth }`, `hits`, `lastUsed`.
- Lookup in the page agent before ranking: try `ref` (stable hash), then `cssPath`, then role+name within landmark. A cached element is accepted only if its role matches and its accessible name still scores ≥ 70 against the target text; else miss → normal FIND → overwrite entry (self-healing).
- Storage: `chrome.storage.local` key `kite.cache`, LRU cap 5000 entries. This corrects an earlier chat statement: the cache lives in the extension's local storage, not `~/.kitestring`; either way it never leaves the machine.
- Never cached: targets on pages with secret fields focused, upload targets' file paths (only the element locator is cached).
- CLI: `kite cache stats | clear [--site <origin>]` via new RPC `cache.stats` / `cache.clear`.
- Result field `cached?: true` on steps resolved from cache (for the benchmark).

## B2. Site memory (stored plans)

Purpose: the real ≥ 5× win. A successful `kite do` run or a recording is stored as a **plan**: the intent, the site, and the batches that completed it, with filled values replaced by named parameters.

- Stored in `~/.kitestring/memory/<origin-slug>/<plan-slug>.json` (mode 0600 dir 0700), schema `{ intent, origin, pathPattern, params: {name, example?, secret}[], batches: Step[][], createdAt, runs, lastOk }`.
- `kite do` looks for a matching plan first (same origin + intent similarity via token overlap ≥ 0.6, or `--plan <slug>`), replays its batches with parameter values filled from the new intent/`--from` file by the model **in one call** (or none, when `--param k=v` covers every parameter), and only falls back to the step-by-step model loop at the first halt.
- `kite memory list | show <slug> | forget <slug>`.

## B3. `kite do "<intent>"`

```
kite do "fill the store listing from ./listing.md" [--from <file>...] [--param k=v...] [--plan <slug>] [--max-rounds 8] [--dry-run] [--json]
```

- Model: DeepSeek V4.1 Flash via DeepSeek's OpenAI-compatible Chat Completions API. Settings: `DEEPSEEK_API_KEY` (required), `KITE_DO_MODEL` (default `deepseek-flash`; sources disagree on the exact id—`deepseek-flash`, `deepseek-v4.1-flash`, `deepseek-v4-flash`—so it is a setting), `KITE_DO_BASE_URL` (default `https://api.deepseek.com`). Plain `fetch`, no SDK. The client is an interface (`planner.ts`) so another OpenAI-compatible provider (or Jev, later) is a config change.
- Loop (CLI side, `packages/cli/src/do/`): snapshot → prompt (intent, `--from` contents, snapshot wrapped in `<page_content>`, the batch step schema, rules) → model returns JSON `{ steps: Step[], done: boolean, note?: string }` (JSON mode / `response_format: json_object`) → validate with the same zod schema as `browser_batch` → `act.batch` → feed the result back → repeat until `done`, a halt the model cannot recover from twice, or `--max-rounds`.
- The model can only emit batch steps. `risky` halts are **not** auto-continued: `kite do` stops and prints the step for the human or calling agent to perform. Upload paths must come from `--from`/`--param` arguments or the intent text; the deny list still applies.
- Success: on `done` with an ok final batch, the plan is stored (B2). Output: per-round summary, total model calls, tokens, wall time.
- Privacy: first run prints, once, "kite do sends page snapshots and your --from files to DeepSeek (api.deepseek.com)"; repeated in README and `kite do --help`. `--dry-run` prints the first planned batch without acting.
- `kite doctor` adds check `do-model`: key present, and a `GET /models` call lists `KITE_DO_MODEL` (skipped when no key, reported as "not configured", not a failure).

## B4. Record → skill

```
kite record start --name <slug>     # starts recording in the session's active tab
kite record stop                    # writes the skill
```

- A recorder content script (injected only while recording) captures **the human's** click, change, input-commit (blur/enter), select, submit, and file-input events, converting each element to a target (accessible name + role + within landmark, via page-agent) and each into a batch step. Navigations become `expect: {url}` on the step that caused them.
- Values: every filled value becomes a parameter `{{field_slug}}` with the recorded value as `example`, except `type=password`, `autocomplete` cc-*/one-time-code, which become secret parameters with no example and are never stored. File inputs record basenames only, as parameters.
- Output: `~/.agents/skills/kite-<slug>/SKILL.md` (frontmatter `name`, `description` "Replays <intent> on <origin> with Kitestring"), containing when-to-use, parameter list, and a `kite batch` JSON block; plus the same plan in site memory (B2) so `kite do` can reuse it. The `~/.claude/skills` symlink is created as `kite init` does. Existing skill folder → refuse unless `--force` (backup to `~/.agents/kite-backups/skills/`).
- The side panel shows a "Recording" banner with a Stop button while active.

## B5. Benchmark

- `pnpm bench` (`apps/bench`): starts the torture server and the e2e Chromium-with-extension harness, then times tasks (`multi-page-checkout`, `store-listing`, `cookie-wall`, `file-upload`) under modes:
  1. single actions, one per step (scripted, simulates today's agent pattern)
  2. one batch per page (scripted)
  3. `kite do` first run (model)
  4. `kite do` repeat (stored plan)
- Reports wall time, browser time, model calls, tokens; writes `docs/bench.md` table. Modes 3–4 need `DEEPSEEK_API_KEY` and spend credits: **skipped unless `KITE_BENCH_MODEL=1`**, and Claude runs them only with the user's go-ahead.
- Exit test: mode 4 time-to-done ≥ 5× faster than mode 3 on `store-listing` and `multi-page-checkout` (asserted by the bench script when model modes run).

## B6. Windows host install

- `install/host-manifest.ts`: on `win32`, write the manifest JSON to `%LOCALAPPDATA%\Kitestring\com.kitestring.bridge.json` and register it with `reg add HKCU\Software\Google\Chrome\NativeMessagingHosts\com.kitestring.bridge /ve /t REG_SZ /d <path> /f`; wrapper `host.cmd` instead of the shell wrapper.
- Socket: on `win32` use a named pipe `\\.\pipe\kitestring-<username>` (Node `net` supports it); `paths.ts` centralizes it. Pipe ACL default (current user) is acceptable; document.
- Shim `kite.cmd` in `%LOCALAPPDATA%\Kitestring\bin`, with instructions to add it to PATH.
- Agent config paths on Windows (`%USERPROFILE%\.codex\config.toml`, `%USERPROFILE%\.cursor\mcp.json`, `%APPDATA%\opencode\...` etc.) in `init/agents.ts`.
- Unit tests mock `process.platform` and `execFile`. Status in README: "Windows: untested".

## B7. Web Store package

- `pnpm package:store` builds production, **strips `manifest.key`** (the Store assigns its own id), zips to `dist/kitestring-<version>.zip`.
- Because the Store id differs from the dev id, the host manifest's `allowed_origins` lists both: `EXTENSION_ID` plus `KITE_STORE_EXTENSION_ID` (constant left empty until the user's first upload gives the id; `kite init` writes whichever are set).
- `store/listing.md`: name, summary (≤ 132 chars), description, category, single-purpose statement, and permission justifications (`debugger`, `nativeMessaging`, `<all_urls>`, `tabs`, `tabGroups`, `scripting`, `storage`, `sidePanel`) written plainly; `store/privacy.md` (no data collected or transmitted by the extension; `kite do` is a separate CLI feature that talks to DeepSeek only when the user configures it).
- Screenshots 1280×800 generated by an e2e spec into `store/screenshots/` (only with `KITE_UPDATE_DOCS=1`, like `docs/ui`).
- The user submits. Suggested demo: an agent submits it through Kitestring using the `store-listing` skill flow.

## B8. README + demo GIF

README gains: batching, guards, upload (with deny list), `kite do` (with the DeepSeek data notice), record → skill, benchmark table, Windows status. Demo GIF (`docs/demo.gif`) recorded by a Playwright spec: side panel + torture `store-listing` filled by one batch.

---

## C. Order and plans

Two plans, executed in order: **M3 plan** (A1–A6), then **M6 plan** (B1–B8). Within M6, B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8.

## D. Calls made by Claude (not decided by the user)

- File upload moved into M3 (user agreed); the risky-click confirm stays M4, with the keyword halt (A6) as a stopgap.
- Batch cap 40 s, max 50 steps, halt on `risky`/`dialog`/`domain`.
- Popup closer prefers "reject" over "accept"; runs only on `blocked`.
- Confirm/prompt dialogs dismissed by default.
- Upload deny list and `KITE_UPLOAD_ALLOW` override.
- Action cache in `chrome.storage.local`; plans in `~/.kitestring/memory`.
- `kite do` is CLI-only in M6; model id is a setting defaulting to `deepseek-flash`.
- Recording captures the human's actions; secret fields never stored.
- No publishing of any kind; Windows untested.

## D2. Clarifications from the builder check (binding; override A/B text where they differ)

1. **Batch budget per agent.** `BatchParams.budget_ms` (default 40_000, clamped 5_000..40_000). The MCP server reads `KITE_BATCH_BUDGET_MS` from its env and passes it on every `browser_batch` call; `kite init` writes it per agent (OpenCode: 12_000; others: unset → 40_000). CLI `kite batch --budget <ms>`.
2. **No step outlives the budget.** Each step runs with cap `min(ACTION_CAP_MS, remaining − 1_000)` and its `wait` clamped to the remaining budget, using the existing `capped`/`Progress.expired` mechanism (expired steps send no more input; the lock is held until the step truly ends, as `EXPIRED_HOLD_MS` does today). No separate 44 s hard answer. A step that expires reports `timeout`, the batch halts with reason `time`, and `next` is **that step's index** (it may have partially acted; the agent re-checks before resending).
3. **Domain guard.** Checked on the active tab's URL after each step settles (not on intermediate redirects). Adopted tabs that are not active are not checked. `switch_tab` to a tab on a foreign domain halts with `domain` unless it is allowed. The `oauth-popup` torture page uses a different host alias (registrable domain differs), and its exit test passes `allow_domains`, which is the realistic agent behavior.
4. **Risk keywords.** "checkout" is removed from the list; "Place order" covers that flow.
5. **Plans store no values.** Stored plans (B2) and recorded skills (B4) keep **no example values at all**: every fill/select value and upload file in a stored plan is a parameter named from its target (`{{shipping_full_name}}`); secret parameters are those whose field was password / cc-* / one-time-code. Refs are never stored: each `StepResult` carries an internal `resolved: {role, name, within?}` from the pipeline, and plans are written with those text targets.
6. **Cache ownership.** The background owns the cache (in-memory map, flushed to `chrome.storage.local` at most every 5 s). On FIND it passes the cached locator as a hint to the page agent's `find`; the agent verifies (role match, name score ≥ 70) and returns whether the hint was used. The background then updates the entry.
7. **Locks follow the batch.** A batch holds the lock of the tab it is acting on. `switch_tab` releases the old tab's lock and queues for the new tab's lock.
8. **Redaction before `kite do` model calls.** Snapshots already mask password values (`••••`). `kite do` additionally masks values of cc-* and one-time-code fields, and replaces any `--param` value marked secret (`--secret k=v`) wherever it appears in text sent to the model. Other field values are sent (the model needs them); the privacy notice says so.
9. The parent spec is `docs/superpowers/specs/2026-10-17-bx-design.md` in this repo.
10. The file-chooser fallback is required (the `file-upload` drop zone has no associated input); it runs inside the tab lock and the step cap, and interception is turned off in a `finally`.

## E. Left to the builder

File/module split inside the stated packages, exact prompt wording for `kite do`, CMP selector details, public-suffix subset contents, side-panel styling of batch groups and the recording banner, benchmark output formatting.
