import {
  BATCH_STEP_MIN_START_MS,
  ErrorCode,
  clampBudget,
  isRisky,
  parseTarget,
  type ActionResult,
  type ActivityEntry,
  type BatchParams,
  type BatchResult,
  type DialogEvent,
  type HaltReason,
  type Status,
  type Step,
  type StepResult,
  type Target,
} from "@kitestring/protocol"
import { diffSnapshots, type FindResult } from "@kitestring/page-agent"
import { resultSummary } from "./activity"
import { callAgent } from "./agent-bridge"
import { assertNotPaused } from "./control"
import { RestrictedPageError, RpcError } from "./errors"
import { allowedSites, capDiff, dialogHalt, fitResult, haltFor, siteOf, stepTarget, urlMatches } from "./batch-result"
import { runStep, type Found, type StepAction, type StepOutcome } from "./pipeline"
import { RECORDED_TAB_DETAIL, TabRecordedError } from "./recorder"
import { withTabLock, type TabLock } from "./serial"
import { TAB_CLOSED_ITSELF } from "./tab-closed"
import { activeTab, agentActing, newestAdopted, openerOf, useTab, type Session } from "./sessions"

/** Same as the pipeline's ACTION_CAP_MS: no step runs longer than a single action may. */
const STEP_CAP_MS = 15_000
/** Every step ends this long before the budget, leaving time to answer. */
const STEP_MARGIN_MS = 1_000
const FIND_POLL_MS = 200
/** switch_tab "new" without `wait`: adoption follows chrome.tabs.onCreated asynchronously. */
const SWITCH_NEW_WAIT_MS = 3_000
const EMPTY = { added: [], removed: [] }
/** Enter, with or without modifiers ("Shift+Enter"): it may submit the focused field's form. */
const isEnter = (key: string) => /(^|\+)Enter$/.test(key)

/** A late-appearing target still gets this long to act after its `wait`. */
const ACT_AFTER_WAIT_MS = 2_000
/** Floor for one bounded agent call near the end of the budget. */
const AGENT_FLOOR_MS = 300

/**
 * Where an agent resends from (`steps.slice(next)`): the halting step itself when it sent no input,
 * when it expired mid-way (`time`: it may have partly acted, the agent re-checks), or when a dialog
 * it opened was dismissed (its effect was cancelled; resend it with a dialog policy). Otherwise the
 * step did its part and `next` is the one after.
 */
function nextAfter(i: number, reason: HaltReason, acted: boolean): number {
  return !acted || reason === "time" || reason === "dialog" ? i : i + 1
}

export type ActivityRecord = Omit<ActivityEntry, "id" | "ts">

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), sleep(ms).then(() => fallback)])
}

async function tabInfo(tabId: number): Promise<{ url: string; title: string }> {
  try {
    const t = await chrome.tabs.get(tabId)
    return { url: t.url || t.pendingUrl || "", title: t.title ?? "" }
  } catch {
    return { url: "", title: "" }
  }
}

/** Takes the tab's lock and keeps it until `release()` (withTabLock scopes it to a callback). */
function holdLock(tabId: number, until: number): Promise<TabLock> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error("budget")), until - Date.now())
  return new Promise<TabLock>((resolve, reject) => {
    withTabLock(
      tabId,
      (lock) =>
        new Promise<void>((done) => {
          clearTimeout(timer)
          resolve({
            release: () => {
              lock.release()
              done()
            },
          })
        }),
      { signal: ctl.signal },
    ).catch((e: unknown) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

const isPaused = (e: unknown) => e instanceof RpcError && e.code === ErrorCode.PAUSED

/** How one step ended, before the after-step guards. */
interface Ran {
  status: Status | "skipped"
  detail?: string
  res?: StepOutcome
  halt?: HaltReason
  /** The step's own input went out (or it switched tabs / waited). */
  acted: boolean
}

/**
 * Runs `params.steps` under one tab lock (moved by switch_tab) within the time budget. Targets are
 * resolved lazily by each step's own FIND; the first halting step stops the batch, and `next` tells
 * the agent which step to resend from.
 */
export async function runBatch(
  s: Session,
  params: BatchParams,
  opts: { batchId: number; record: (e: ActivityRecord) => void },
): Promise<BatchResult> {
  const t0 = Date.now()
  const deadline = t0 + clampBudget(params.budget_ms)
  const remaining = () => deadline - Date.now()
  let tabId = params.tab ?? activeTab(s)
  if (!s.tabs.has(tabId)) {
    throw new RpcError(ErrorCode.NOT_OWNER, `NOT_OWNER: tab ${tabId} does not belong to session "${s.name}"`)
  }
  const startTab = tabId
  const allowed = allowedSites(params)
  const steps: StepResult[] = []
  const dialogs: DialogEvent[] = []
  const closedPopups: string[] = []
  const newTabs: number[] = []
  let halted: BatchResult["halted"]
  let next: number | undefined
  let haltRes: ActionResult | undefined
  let navigated = false
  let startUrl: string | undefined
  let lock: TabLock | undefined
  /** Until the last step has truly ended (an expired step may still unwind): keep the lock. */
  let linger: Promise<void> = Promise.resolve()
  /** Every tab the batch worked on counts as agent-active until the batch ends (popups opened between steps are adopted). */
  const acting = new Map<number, () => void>()
  const actOn = (id: number) => {
    if (!acting.has(id)) acting.set(id, agentActing(id))
  }

  const halt = (index: number, reason: HaltReason, detail?: string, nextIndex = index) => {
    halted = { index, reason, ...(detail ? { detail } : {}) }
    next = nextIndex
  }
  /** An agent call that cannot run past the budget (by more than AGENT_FLOOR_MS) or `capMs`. */
  const agentQuick = <T>(method: "snapshot" | "brief" | "hasText" | "find", args: unknown[], fallback: T, capMs = 2_000): Promise<T> =>
    bounded(callAgent<T>(tabId, method, args), Math.max(AGENT_FLOOR_MS, Math.min(capMs, remaining())), fallback)

  try {
    lock = await holdLock(tabId, deadline - BATCH_STEP_MIN_START_MS)
  } catch (e) {
    if (isPaused(e)) halt(0, "paused", (e as Error).message)
    else if (e instanceof TabRecordedError) halt(0, "error", RECORDED_TAB_DETAIL)
    else halt(0, "time", `waited ${Date.now() - t0} ms for another action on tab ${tabId}`)
    return fitResult({ ok: false, steps, halted, next, diff: EMPTY, page: await agentQuick("brief", [], "") })
  }

  actOn(tabId)
  try {
    const before = await agentQuick("snapshot", [{ full: false }], "")
    startUrl = (await tabInfo(tabId)).url
    const start = siteOf(startUrl)
    if (start) allowed.add(start)

    const findTarget = async (target: Target, intent: string, waitMs: number): Promise<boolean> => {
      const end = Date.now() + waitMs
      for (;;) {
        const f = await agentQuick<FindResult>("find", [target, intent], { kind: "not_found" }, end - Date.now())
        if (f.kind !== "not_found") return true
        if (Date.now() + FIND_POLL_MS > end) return false
        await sleep(FIND_POLL_MS)
      }
    }

    const switchTab = async (step: Extract<Step, { action: "switch_tab" }>): Promise<Ran> => {
      let to: number | undefined
      if (step.to === "new") {
        const end = Date.now() + Math.min(step.wait ?? SWITCH_NEW_WAIT_MS, remaining() - STEP_MARGIN_MS)
        while ((to = newestAdopted(s, t0)) === undefined && Date.now() + 100 <= end) await sleep(100)
        if (to === undefined) {
          if (step.if_present) return { status: "skipped", acted: false }
          return { status: "not_found", detail: "no new tab was opened during this batch", halt: "not_found", acted: false }
        }
      } else if (step.to === "opener") {
        to = openerOf(s, tabId)
        if (to === undefined) return { status: "error", detail: `tab ${tabId} has no opener`, halt: "error", acted: false }
        if (!s.tabs.has(to)) return { status: "error", detail: `opener tab ${to} of tab ${tabId} is closed`, halt: "error", acted: false }
      } else {
        to = step.to
        if (!s.tabs.has(to)) {
          return { status: "error", detail: `NOT_OWNER: tab ${to} does not belong to session "${s.name}"`, halt: "error", acted: false }
        }
      }
      if (to !== tabId) {
        await linger
        lock?.release()
        lock = undefined
        try {
          lock = await holdLock(to, deadline - STEP_MARGIN_MS)
        } catch (e) {
          if (isPaused(e)) return { status: "error", detail: (e as Error).message, halt: "paused", acted: false }
          if (e instanceof TabRecordedError) return { status: "error", detail: RECORDED_TAB_DETAIL, halt: "error", acted: false }
          return { status: "timeout", detail: `waited for another action on tab ${to}`, halt: "time", acted: false }
        }
        tabId = to
        actOn(to)
        navigated = true
      }
      await useTab(s, to)
      return { status: "done", acted: true }
    }

    const execute = async (step: Step): Promise<Ran> => {
      if (step.action === "switch_tab") return switchTab(step)
      if (step.action === "wait") {
        await sleep(Math.min(step.ms ?? 0, remaining() - STEP_MARGIN_MS))
        return { status: "done", acted: true }
      }
      let action: StepAction
      if (step.action === "goto") action = { kind: "goto", url: step.url }
      else if (step.action === "press") action = { kind: "press", key: step.key }
      else if (step.action === "scroll") action = { kind: "scroll", direction: step.direction, ...(step.px ? { px: step.px } : {}) }
      else {
        const target = typeof step.target === "string" ? parseTarget(step.target, step) : step.target
        if (step.wait || step.if_present) {
          const waitMs = Math.min(step.wait ?? 0, remaining() - STEP_MARGIN_MS - ACT_AFTER_WAIT_MS)
          const present = await findTarget(target, step.action === "upload" ? "click" : step.action, waitMs)
          if (!present && step.if_present) return { status: "skipped", acted: false }
        }
        action =
          step.action === "upload"
            ? { kind: "upload", target, files: step.files }
            : { kind: step.action, target, ...(step.action === "click" ? {} : { value: step.value }) }
      }
      try {
        const res = await runStep(s, tabId, action, {
          capMs: Math.min(STEP_CAP_MS, remaining() - STEP_MARGIN_MS),
          ...(step.dialog ? { dialog: step.dialog } : {}),
          // A click, or an Enter that would submit a form (checked against that form's submit button).
          ...(step.action === "click" || (step.action === "press" && isEnter(step.key))
            ? { beforeAct: (f: Found) => (isRisky(f.name) ? "risky" : null) }
            : {}),
          linger: (t) => (linger = t),
        })
        const halt = res.halt ?? haltFor(res.status) ?? undefined
        return { status: res.status, ...(res.detail ? { detail: res.detail } : {}), res, ...(halt ? { halt } : {}), acted: res.acted }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        // Thrown before any input (BAD_REQUEST key, restricted URL, PAUSED, no tab...).
        if (e instanceof RestrictedPageError) return { status: "restricted", detail, halt: "restricted", acted: false }
        return { status: "error", detail, halt: isPaused(e) ? "paused" : "error", acted: false }
      }
    }

    /** Domain guard, dialogs and expect, on a step that ran without halting. */
    const guards = async (step: Step, i: number, ran: Ran): Promise<{ reason: HaltReason; detail: string } | null> => {
      const d = dialogHalt(ran.res?.dialogs, step)
      if (d) return { reason: "dialog", detail: d }
      const { url } = await tabInfo(tabId)
      const site = siteOf(url)
      if (site && !allowed.has(site)) {
        return { reason: "domain", detail: `landed on ${site} (${url}), not one of ${[...allowed].join(", ")}; pass allow_domains to go on` }
      }
      const want = step.expect
      if (want && "text" in want && !(await agentQuick("hasText", [want.text], false))) {
        return { reason: "expect", detail: `expected text ${JSON.stringify(want.text)} is not on the page` }
      }
      if (want && "url" in want && !urlMatches(url, want.url)) {
        return { reason: "expect", detail: `expected url ${JSON.stringify(want.url)}, page is at ${url}` }
      }
      return null
    }

    for (let i = 0; i < params.steps.length && !halted; i++) {
      const step = params.steps[i]!
      try {
        assertNotPaused()
      } catch (e) {
        halt(i, "paused", (e as Error).message)
        break
      }
      if (remaining() < BATCH_STEP_MIN_START_MS) {
        halt(i, "time", `${Math.max(0, remaining())} ms of the ${deadline - t0} ms batch budget left`)
        break
      }
      const t = Date.now()
      const stepTab = tabId
      const openerBefore = openerOf(s, tabId)
      const ran = await execute(step)
      const res = ran.res
      let handoff: { reason: HaltReason; detail: string } | undefined
      if (res?.detail === TAB_CLOSED_ITSELF && ran.acted && !ran.halt) {
        // The step closed its own tab (an OAuth popup's "Allow"): carry on in its opener, never in whatever is active.
        const closed = tabId
        const to = openerBefore !== undefined && s.tabs.has(openerBefore) ? openerBefore : undefined
        if (to !== undefined) {
          await linger
          lock?.release()
          lock = undefined
          try {
            lock = await holdLock(to, deadline - STEP_MARGIN_MS)
            tabId = to
            actOn(to)
            navigated = true
            await useTab(s, to)
          } catch (e) {
            handoff = isPaused(e)
              ? { reason: "paused", detail: (e as Error).message }
              : e instanceof TabRecordedError
                ? { reason: "error", detail: RECORDED_TAB_DETAIL }
                : { reason: "time", detail: `waited for another action on tab ${to}` }
          }
        } else if (i + 1 < params.steps.length) {
          handoff = { reason: "error", detail: `tab ${closed} closed` }
        }
      }
      if (res) {
        for (const e of res.dialogs ?? []) dialogs.push(e)
        for (const p of res.closedPopups ?? []) closedPopups.push(p)
        for (const id of res.newTabs ?? []) if (!newTabs.includes(id)) newTabs.push(id)
        if (res.navigation) navigated = true
      }
      if (!halted && ran.halt) {
        halt(i, ran.halt, ran.detail, nextAfter(i, ran.halt, ran.acted))
        haltRes = res
      } else if (!halted && ran.status !== "skipped") {
        const g = await guards(step, i, ran)
        if (g) halt(i, g.reason, g.detail, nextAfter(i, g.reason, ran.acted))
      }
      if (!halted && handoff) halt(i, handoff.reason, handoff.detail, i + 1)
      const target = stepTarget(step)
      const result: StepResult = {
        i,
        action: step.action,
        ...(target !== undefined ? { target } : {}),
        status: ran.status,
        ...(ran.detail ? { detail: ran.detail } : {}),
        ms: Date.now() - t,
        ...(res?.cached ? { cached: true } : {}),
        ...(res?.resolved ? { resolved: res.resolved } : {}),
        ...(res?.secret ? { secret: true as const } : {}),
      }
      steps.push(result)
      if (ran.status !== "skipped") {
        const url = res?.navigation?.url ?? (await tabInfo(stepTab)).url
        opts.record({
          session: s.name,
          tabId: stepTab,
          method: `act.${step.action}`,
          ...(target !== undefined ? { target } : {}),
          status: ran.status,
          ms: result.ms,
          ...(url ? { url } : {}),
          summary: resultSummary({ ok: false, status: ran.status, diff: res?.diff ?? EMPTY, page: "", ...(ran.detail ? { detail: ran.detail } : {}) }),
          ...(res ? { diff: res.diff, page: res.page } : {}),
          ...(res?.dialogs?.length ? { dialogs: res.dialogs } : {}),
          batch: opts.batchId,
        })
      }
    }

    // An unanswered snapshot (page still blocked) is no evidence that everything was removed.
    const [after, info, page] = await Promise.all([
      agentQuick<string | null>("snapshot", [{ full: false }], null),
      tabInfo(tabId),
      agentQuick("brief", [], ""),
    ])
    const out: BatchResult = {
      ok: !halted,
      steps,
      diff: after === null ? EMPTY : capDiff(diffSnapshots(before, after)),
      page,
    }
    if (halted) {
      out.halted = halted
      out.next = next
    }
    if (navigated || tabId !== startTab) out.navigation = info
    if (newTabs.length) out.newTabs = newTabs
    if (dialogs.length) out.dialogs = dialogs
    if (closedPopups.length) out.closedPopups = closedPopups
    if (haltRes?.candidates) out.candidates = haltRes.candidates
    if (haltRes?.blockedBy) out.blockedBy = haltRes.blockedBy
    if (startUrl) out.startUrl = startUrl
    return fitResult(out)
  } finally {
    const held = lock
    void linger.then(() => held?.release())
    for (const ended of acting.values()) ended()
  }
}
