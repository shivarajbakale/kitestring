# M1 follow-ups (deferred from review)

Carried from the M1 subagent-driven-development ledger. Each item was triaged OK TO DEFER by the final review.

- Task 1: minor (deferred): parseTarget no tests for role / ref+within (within silently dropped on ref)
- Task 1: minor (deferred): RpcRequest.params z.record, no per-method validation
- Task 1: minor (deferred): pnpm 12 "Ignored build scripts: esbuild" — may need onlyBuiltDependencies later
- Task 1: minor (deferred): inner error object non-strict, extra fields (e.g. data) stripped
- Task 2: minor (deferred): FrameDecoder poison frame wedges decoder (framing.ts:24-30)
- Task 2: minor (deferred): close() destroy may drop final NOT_CONNECTED replies; use end() first
- Task 2: minor (deferred): startup race two hosts / close unlinks unconditionally / chmod after listen
- Task 2: minor (deferred): main.ts untested; no stdout EPIPE handler, no SIGTERM cleanup; unbounded client buf
- Task 2: minor (deferred): missing tests for forward FrameTooLarge→BAD_REQUEST, client-disconnect pending drop, real dead socket
- Task 2: minor (deferred): probe timeout + non-stale rethrow branches untested; FrameDecoder silent drop without onError; probe errno lacks context
- Task 3: minor (deferred): rpc-client no default post-connect timeout — CLI can hang if daemon/extension never answers (rpc-client.ts:130) — TRIAGE AT FINAL
- Task 3: minor (deferred): response id not checked; tab.list array branch dead; any casts in human(); commander 15 needs Node >=22.12; coverage gaps (quoting, RESTRICTED msg, ECONNREFUSED path)
- Task 4: minor (deferred): rerender rebuild between mousedown/mouseup can drop click (flaky e2e risk); infinite-scroll drops scroll events during load; server main-module check symlink; GET / 404
- Task 5: minor (deferred): stale ref resolves to renamed el; fieldset disabled; global instanceof vs win; opacity:0/clipped not hidden; REF_RE local copy; missing tests (scroll stability, collisions, quotes/newlines, maxLines<=0)
- Task 5: minor (deferred): other sensitive inputs (cc-number, one-time-code) not masked — M4 risk work; header URL may carry tokens; weak scope assertion
- Task 6: minor (deferred): intent not enforced for ref targets; labelTexts limited; test gaps (fill excludes button, select intent, bonuses, hidden-only, within+fill); duplicate commit titles
- Task 6: minor (deferred): intentOk dead `|| isContentEditable` fallback
- Task 7: minor (deferred): visibility:collapse; elementFromPoint null → hidden untested; missing tests (ancestor cover, aria-errormessage)
- Task 7: minor (deferred): setSelect on <select multiple> adds instead of replacing; doc-wide aria-live may pick unrelated toasts as errors; realm-sensitive instanceof
- Task 8: minor (deferred): CLI restricted URL regex drops about:/data:/file: URLs (commands.ts:127-131) — TRIAGE AT FINAL
- Task 8: minor (deferred): concurrent tab.new creates duplicate groups; loadSessions rejection cached forever; use/close on gone tab → INTERNAL; non-"cannot access" page errors → INTERNAL; e2e tmp dir leak if install-host throws; port-null response dropped; coverage gaps (SW restart reload, color cycling, inject+retry)
- Task 9: concerns noted — Playwright harness can't complete click-started cross-site navs (M3 harness change); infinite-scroll uses all 3 retries at 720px; snapshot has no time cap (TRIAGE AT FINAL); no per-tab action serialization (M2)
- Task 9: minor (deferred): pipeline.ts multi-responsibility (split Watch/settle, hasClickHandler); R13 sequential getEventListeners; network-idle in-flight set not cleared on main-frame commit (false timeout risk) — TRIAGE AT FINAL; post-cap work in fill/goto; abandoned waitIdle intervals; __bxStats debug global in prod; multiline contenteditable false mismatch; nbsp test literal invisible; scroll-retry not-found test page can't scroll; targetParam drops bad within/role silently
- Final: parked — inject 10 s cap can pre-empt 15 s action cap (RPC TIMEOUT instead of ActionResult timeout) — Ruling R14: accept for M1; no agent exists so no diff/page possible anyway; exit code same; convert in capped() during M2 — cost if wrong: agents parsing --json see error object instead of status:timeout in that one case.
