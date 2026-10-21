import {
  ErrorCode,
  HANDOFF_REASON_MAX,
  HANDOFF_WAIT_MS,
  RECORD_NAME_RE,
  RpcRequest,
  parseBatchParams,
  type ActionResult,
  type ActivityEntry,
  type DialogEvent,
  type ExtractResult,
  type Method,
  type RpcResponse,
  type Target,
} from "@kitestring/protocol"
import * as activity from "./activity"
import { callAgent, isRestrictedUrl } from "./agent-bridge"
import * as cache from "./cache"
import * as capture from "./capture"
import * as control from "./control"
import { RestrictedPageError, RpcError } from "./errors"
import * as handoff from "./handoff"
import * as notify from "./notify"
import { runBatch } from "./batch"
import { ensureAttached, hold, send } from "./cdp"
import { goto, runAction } from "./pipeline"
import { parseCondition, waitInTab } from "./wait"
import * as recorder from "./recorder"
import { rejectWaiters } from "./serial"
import * as sessions from "./sessions"

// Pausing lets the action holding a tab finish but turns away everything queued behind it.
control.onChange((st) => {
  if (st.paused) rejectWaiters(control.pausedError())
})

/** Batch ids: increasing, and unlikely to repeat ids from before a service-worker restart. */
let nextBatchId = Date.now()

/** Bound on page.snapshot (the only handler outside the action pipeline's cap). */
const SNAPSHOT_CAP_MS = 15_000
/** page.eval: a synchronous run is terminated after this; an awaited promise is abandoned at SNAPSHOT_CAP_MS. */
const EVAL_RUN_MS = 10_000
/** page.wait: default and longest wait. */
const WAIT_DEFAULT_MS = 10_000
const WAIT_MAX_MS = 120_000
/** page.eval: longest expression, and largest JSON value returned. */
const EVAL_EXPRESSION_MAX = 100_000
const EVAL_VALUE_MAX_BYTES = 900_000

/** Rejects with RPC TIMEOUT if `p` has not settled within `ms`. */
function bounded<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RpcError(ErrorCode.TIMEOUT, message)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

type Handler = (params: Record<string, unknown>, session: sessions.Session) => Promise<unknown>

function badRequest(message: string): never {
  throw new RpcError(ErrorCode.BAD_REQUEST, message)
}

function tabIdParam(params: Record<string, unknown>, required: true): number
function tabIdParam(params: Record<string, unknown>, required: false): number | undefined
function tabIdParam(params: Record<string, unknown>, required: boolean): number | undefined {
  const id = params.id
  if (id === undefined && !required) return undefined
  if (typeof id !== "number" || !Number.isInteger(id)) badRequest("params.id must be an integer tab id")
  return id
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const v = params[name]
  if (typeof v !== "string") badRequest(`params.${name} must be a string`)
  return v
}

function targetParam(params: Record<string, unknown>): Target {
  const t = params.target as Record<string, unknown> | undefined
  if (t && typeof t === "object") {
    if (typeof t.ref === "string") return { ref: t.ref }
    if (typeof t.text === "string") {
      const out: { text: string; within?: string; role?: string } = { text: t.text }
      if (typeof t.within === "string") out.within = t.within
      if (typeof t.role === "string") out.role = t.role
      return out
    }
  }
  badRequest("params.target must be {ref} or {text, within?, role?}")
}

function limitParam(params: Record<string, unknown>): number {
  const limit = params.limit
  if (limit === undefined) return 50
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) badRequest("params.limit must be a positive integer")
  return limit
}

const handlers: Partial<Record<Method, Handler>> = {
  status: async () => ({
    connected: true,
    sessions: sessions.sessionNames(),
    paused: control.isPaused(),
    // Scheduled runs wait for the person to be away: "idle" after a minute without input.
    idle: await chrome.idle.queryState(60).catch(() => "active"),
  }),

  "control.pause": async (params) => {
    const reason = params.reason
    if (reason !== undefined && typeof reason !== "string") badRequest("params.reason must be a string")
    await control.pause(reason || undefined)
    return { paused: true }
  },

  "control.resume": async () => {
    await control.resume()
    return { paused: false }
  },

  "control.state": async () => control.getState(),

  "activity.list": async (params) => {
    const limit = params.limit
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
      badRequest("params.limit must be a positive integer")
    }
    return { entries: activity.list(limit) }
  },

  "cache.stats": async () => {
    await cache.ready()
    return cache.stats()
  },

  "cache.clear": async (params) => {
    const site = params.site
    if (site !== undefined && typeof site !== "string") badRequest("params.site must be a string")
    await cache.ready()
    return { cleared: cache.clear(site) }
  },

  "tab.new": async (params, s) => {
    const url = params.url
    if (url !== undefined && typeof url !== "string") badRequest("params.url must be a string")
    const t = await sessions.newTab(s, url, { ownWindow: params.own_window === true, background: params.background === true })
    return { id: t.id, url: t.url }
  },

  "tab.list": async (_params, s) => ({ tabs: await sessions.listTabs(s) }),

  "tab.use": async (params, s) => {
    const t = await sessions.useTab(s, tabIdParam(params, true))
    return { id: t.id, url: t.url }
  },

  "tab.close": async (params, s) => {
    await sessions.closeTab(s, tabIdParam(params, false))
    return null
  },

  "page.snapshot": async (params, s) => {
    const scope = params.scope
    if (scope !== undefined && typeof scope !== "string") badRequest("params.scope must be a string")
    const text = await bounded(
      callAgent<string>(sessions.activeTab(s), "snapshot", [
        { full: params.full === true, ...(scope !== undefined ? { scope } : {}) },
      ]),
      SNAPSHOT_CAP_MS,
      `TIMEOUT: snapshot did not finish within ${SNAPSHOT_CAP_MS} ms (page still loading?)`,
    )
    return { text }
  },

  "page.text": async (params, s) => {
    const max = params.max ?? 100_000
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 1_000_000) badRequest("params.max must be an integer from 1 to 1000000")
    const text = await bounded(
      callAgent<string>(sessions.activeTab(s), "text", [max]),
      SNAPSHOT_CAP_MS,
      `TIMEOUT: page text not read within ${SNAPSHOT_CAP_MS} ms (page still loading?)`,
    )
    return { text }
  },

  "page.extract": async (params, s) => {
    const opts: Record<string, unknown> = {}
    for (const k of ["near", "selector", "key"] as const) {
      if (params[k] === undefined) continue
      if (typeof params[k] !== "string" || !params[k]) badRequest(`params.${k} must be a non-empty string`)
      opts[k] = params[k]
    }
    for (const [k, hi] of [["pick", 50], ["max", 5_000]] as const) {
      const v = params[k]
      if (v === undefined) continue
      if (typeof v !== "number" || !Number.isInteger(v) || v < (k === "pick" ? 0 : 1) || v > hi) badRequest(`params.${k} must be an integer up to ${hi}`)
      opts[k] = v
    }
    try {
      return await bounded(
        callAgent<ExtractResult>(sessions.activeTab(s), "extract", [opts]),
        SNAPSHOT_CAP_MS,
        `TIMEOUT: page data not read within ${SNAPSHOT_CAP_MS} ms (page still loading?)`,
      )
    } catch (e) {
      // The page has no such data, or the selector is wrong: the caller's to fix, not a failure of Kitestring.
      const m = e instanceof Error ? e.message : ""
      if (/^(no table|no visible element|not a valid CSS selector|the table or list|pick \d)/.test(m)) badRequest(m)
      throw e
    }
  },

  "page.eval": async (params, s) => {
    const expression = stringParam(params, "expression")
    if (!expression.trim() || expression.length > EVAL_EXPRESSION_MAX) badRequest(`params.expression must be 1 to ${EVAL_EXPRESSION_MAX} characters`)
    const tabId = sessions.activeTab(s)
    const url = (await tabUrl(tabId)) ?? ""
    if (isRestrictedUrl(url)) throw new RestrictedPageError(url)
    const release = hold(tabId)
    try {
      await ensureAttached(tabId)
      const r = await bounded(
        send<{ result: { value?: unknown; type: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(tabId, "Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout: EVAL_RUN_MS,
        }),
        SNAPSHOT_CAP_MS,
        `TIMEOUT: page script did not finish within ${SNAPSHOT_CAP_MS} ms`,
      )
      if (r.exceptionDetails) {
        const d = r.exceptionDetails
        badRequest(`page script threw: ${(d.exception?.description ?? d.text).split("\n")[0]}`)
      }
      const value = r.result.value
      if (value !== undefined && JSON.stringify(value).length > EVAL_VALUE_MAX_BYTES) {
        badRequest(`page script returned more than ${EVAL_VALUE_MAX_BYTES} bytes of JSON; return less`)
      }
      return value === undefined ? {} : { value }
    } finally {
      release()
    }
  },

  "page.wait": async (params, s) => {
    const cond = parseCondition(params.cond)
    const ms = params.timeout_ms ?? WAIT_DEFAULT_MS
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > WAIT_MAX_MS) badRequest(`params.timeout_ms must be an integer from 0 to ${WAIT_MAX_MS}`)
    return waitInTab(sessions.activeTab(s), cond, ms)
  },

  "page.console": async (params, s) => {
    const level = params.level
    if (level !== undefined && level !== "error" && level !== "warn" && level !== "all") {
      badRequest('params.level must be "error", "warn" or "all"')
    }
    const tabId = sessions.activeTab(s)
    await capture.ensureCapturing(tabId)
    return {
      entries: capture.consoleEntries(tabId, {
        ...(level !== undefined ? { level } : {}),
        limit: limitParam(params),
        clear: params.clear === true,
      }),
    }
  },

  "page.network": async (params, s) => {
    const filter = params.filter
    if (filter !== undefined && typeof filter !== "string") badRequest("params.filter must be a string")
    const tabId = sessions.activeTab(s)
    await capture.ensureCapturing(tabId)
    return {
      entries: capture.networkEntries(tabId, {
        failed: params.failed === true,
        ...(filter ? { filter } : {}),
        limit: limitParam(params),
        clear: params.clear === true,
      }),
    }
  },

  "page.screenshot": async (params, s) => {
    const ref = params.ref
    if (ref !== undefined && typeof ref !== "string") badRequest("params.ref must be a string")
    return capture.screenshot(sessions.activeTab(s), { full: params.full === true, ...(ref !== undefined ? { ref } : {}) })
  },

  "page.goto": async (params, s) => goto(s, stringParam(params, "url")),

  "act.click": async (params, s) => runAction(s, { kind: "click", target: targetParam(params) }),

  "act.fill": async (params, s) =>
    runAction(s, { kind: "fill", target: targetParam(params), value: stringParam(params, "text") }),

  "act.select": async (params, s) =>
    runAction(s, { kind: "select", target: targetParam(params), value: stringParam(params, "value") }),

  "act.upload": async (params, s) => {
    const files = params.files
    if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string" && f !== "")) {
      badRequest("params.files must be a non-empty array of paths")
    }
    // The CLI resolves and vets paths (kite upload / browser_upload); a relative path means a client that skipped that.
    if (!(files as string[]).every((f) => f.startsWith("/") || /^[A-Za-z]:[\\/]/.test(f))) {
      badRequest("params.files must be absolute paths")
    }
    return runAction(s, { kind: "upload", target: targetParam(params), files: files as string[] })
  },

  "act.batch": async (params, s) => {
    let batch
    try {
      batch = parseBatchParams(params)
    } catch (e) {
      badRequest(`invalid batch: ${(e as Error).message}`)
    }
    // Same backstop as act.upload: the CLI / MCP server resolve and vet upload paths.
    for (const [i, step] of batch.steps.entries()) {
      if (step.action === "upload" && !step.files.every((f) => f.startsWith("/") || /^[A-Za-z]:[\\/]/.test(f))) {
        badRequest(`invalid batch: steps[${i}].files must be absolute paths`)
      }
    }
    // Each step records its own activity entry (the router records nothing for the batch itself).
    return runBatch(s, batch, { batchId: nextBatchId++, record: (e) => void activity.record(e) })
  },

  "act.press": async (params, s) => runAction(s, { kind: "press", key: stringParam(params, "key") }),

  "record.start": async (params, s) => {
    const name = stringParam(params, "name")
    if (!RECORD_NAME_RE.test(name)) badRequest("params.name must be a lowercase slug like ada-signup (a-z, 0-9, -; at most 48)")
    return recorder.startRecording(sessions.activeTab(s), name)
  },

  "human.ask": async (params, s) => {
    const reason = stringParam(params, "reason").trim()
    if (!reason) badRequest("params.reason must not be empty")
    const wait = params.wait_ms ?? HANDOFF_WAIT_MS
    if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0) badRequest("params.wait_ms must be a non-negative number")
    return handoff.ask(s.name, s.activeTabId ?? null, reason.slice(0, HANDOFF_REASON_MAX), Math.min(wait, HANDOFF_WAIT_MS))
  },

  notify: async (params) => {
    const title = stringParam(params, "title").slice(0, 80)
    const message = stringParam(params, "message").slice(0, 300)
    const tab = params.tab
    if (tab !== undefined && (typeof tab !== "number" || !Number.isInteger(tab))) badRequest("params.tab must be an integer tab id")
    const url = params.url
    if (url !== undefined && (typeof url !== "string" || !/^https?:\/\//.test(url))) badRequest("params.url must be an http(s) URL")
    notify.show(title, message, tab as number | undefined, url as string | undefined)
    return null
  },

  "record.stop": async (params) => (params.peek === true ? recorder.peekRecording() : recorder.stopRecording()),

  "act.scroll": async (params, s) => {
    const direction = params.direction
    if (direction !== "up" && direction !== "down") badRequest('params.direction must be "up" or "down"')
    const px = params.px
    if (px !== undefined && (typeof px !== "number" || !Number.isFinite(px) || px <= 0)) {
      badRequest("params.px must be a positive number")
    }
    const at = params.at as { x?: unknown; y?: unknown } | undefined
    if (at !== undefined && (typeof at !== "object" || at === null || [at.x, at.y].some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0))) {
      badRequest("params.at must be {x, y}: a point in the viewport, in CSS pixels")
    }
    return runAction(s, { kind: "scroll", direction, ...(px !== undefined ? { px } : {}), ...(at ? { at: { x: at.x as number, y: at.y as number } } : {}) })
  },
}

/** Only opening a tab creates a session; other methods must not register sessions as a side effect. */
const CREATES_SESSION: ReadonlySet<Method> = new Set(["tab.new"])

/** Methods that still answer while the user has paused Kitestring. */
const WHILE_PAUSED: ReadonlySet<Method> = new Set([
  "status",
  "tab.list",
  "control.pause",
  "control.resume",
  "control.state",
  "activity.list",
  "cache.stats",
  "cache.clear",
  "record.stop",
  // Asking the person does not act; they may well have paused to take over.
  "human.ask",
  // A scheduled run says it was skipped because of the pause.
  "notify",
])

/** Methods that act in the session's tab: refused while the human is recording it, so only their actions are recorded. */
const actsInTab = (m: Method): boolean => m.startsWith("act.") || m === "page.goto"
/**
 * Methods that read the session's tab: refused while the human is recording it (R13), since a snapshot shows field values
 * and console / network entries can carry form posts. (A screenshot is also refused by the tab lock it takes.)
 */
const READS_TAB = new Set<Method>(["page.snapshot", "page.text", "page.extract", "page.eval", "page.wait", "page.console", "page.network", "page.screenshot"])

/** Methods that change something: recorded in the activity log, successful or not. */
function isRecorded(m: Method): boolean {
  return (
    m === "tab.new" ||
    m === "tab.close" ||
    m === "page.goto" ||
    // A page script can change the page as much as an action can.
    m === "page.eval" ||
    (m.startsWith("act.") && m !== "act.batch") ||
    m === "control.pause" ||
    m === "control.resume"
  )
}

function describeTarget(method: Method, params: Record<string, unknown>): string | undefined {
  const t = params.target as { ref?: unknown; text?: unknown; within?: unknown } | undefined
  // Base names only: a directory layout is not for the activity log.
  const names =
    method === "act.upload" && Array.isArray(params.files)
      ? ` ← ${params.files.filter((f): f is string => typeof f === "string").map((f) => f.split(/[\\/]/).pop()).join(", ")}`
      : ""
  if (t && typeof t === "object") {
    if (typeof t.ref === "string") return t.ref + names
    if (typeof t.text === "string") {
      return `"${t.text}"${typeof t.within === "string" ? ` within "${t.within}"` : ""}${names}`
    }
  }
  // Never the value of act.fill / act.select: it may be a secret.
  if (method === "act.press" && typeof params.key === "string") return params.key
  if (method === "act.scroll" && typeof params.direction === "string") {
    return typeof params.px === "number" ? `${params.direction} ${params.px}` : params.direction
  }
  if ((method === "page.goto" || method === "tab.new") && typeof params.url === "string") return params.url
  if (method === "page.eval" && typeof params.expression === "string") {
    const e = params.expression.replace(/\s+/g, " ").trim()
    return e.length > 80 ? `${e.slice(0, 79)}…` : e
  }
  if (method === "tab.close" && typeof params.id === "number") return String(params.id)
  return undefined
}

async function tabUrl(tabId: number | null): Promise<string | undefined> {
  if (tabId === null) return undefined
  try {
    const t = await chrome.tabs.get(tabId)
    return t.url || t.pendingUrl || undefined
  } catch {
    return undefined
  }
}

type Outcome = { result: unknown } | { error: { code: string; message: string } }

async function recordActivity(
  req: RpcRequest,
  tabBefore: number | null,
  ms: number,
  outcome: Outcome,
): Promise<void> {
  const target = describeTarget(req.method, req.params)
  const entry: Omit<ActivityEntry, "id" | "ts"> = {
    session: req.session,
    method: req.method,
    ms,
    tabId: tabBefore,
    status: "done",
    summary: "",
  }
  if (target !== undefined) entry.target = target
  if ("error" in outcome) {
    entry.status = outcome.error.code as ErrorCode
    entry.summary = activity.errorSummary(outcome.error.code, outcome.error.message)
    const url = await tabUrl(tabBefore)
    if (url) entry.url = url
  } else if (req.method === "tab.new") {
    const r = outcome.result as { id: number; url: string }
    entry.tabId = r.id
    entry.url = r.url
    entry.summary = `✓ tab ${r.id} ${r.url}`.trimEnd()
  } else if (req.method === "control.pause" || req.method === "control.resume") {
    // Global, not about any tab.
    entry.tabId = null
    const reason = typeof req.params.reason === "string" && req.params.reason ? req.params.reason : undefined
    entry.summary = activity.controlSummary(req.method, reason)
  } else if (req.method === "page.eval") {
    entry.summary = "✓ ran a page script"
    const url = await tabUrl(tabBefore)
    if (url) entry.url = url
  } else if (req.method === "tab.close") {
    entry.summary = tabBefore === null ? "✓ closed" : `✓ closed tab ${tabBefore}`
  } else {
    const r = outcome.result as ActionResult
    entry.status = r.status
    entry.summary = activity.resultSummary(r)
    entry.diff = r.diff
    entry.page = r.page
    if (r.dialogs?.length) entry.dialogs = r.dialogs
    const url = r.navigation?.url ?? (await tabUrl(tabBefore))
    if (url) entry.url = url
  }
  activity.record(entry)
}

/** A dialog the background guard answered between calls: its own entry, under the tab's owner. */
export async function recordGuardDialog(tabId: number, dialog: DialogEvent): Promise<void> {
  await Promise.all([sessions.loadSessions(), activity.ready()])
  const url = await tabUrl(tabId)
  activity.record({
    session: sessions.ownerOf(tabId)?.name ?? "-",
    tabId,
    method: "dialog",
    status: "done",
    ms: 0,
    summary: activity.dialogSummary(dialog),
    dialogs: [dialog],
    ...(url ? { url } : {}),
  })
}

function errorOf(e: unknown): { code: string; message: string } {
  if (e instanceof RestrictedPageError) return { code: ErrorCode.RESTRICTED, message: e.message }
  if (e instanceof RpcError) return { code: e.code, message: e.message }
  return { code: ErrorCode.INTERNAL, message: e instanceof Error ? e.message : String(e) }
}

export async function route(raw: unknown): Promise<RpcResponse> {
  const parsed = RpcRequest.safeParse(raw)
  const rawId = (raw as { id?: unknown } | null)?.id
  if (!parsed.success) {
    return {
      id: typeof rawId === "number" ? rawId : 0,
      error: { code: ErrorCode.BAD_REQUEST, message: parsed.error.message },
    }
  }
  const req = parsed.data
  const handler = handlers[req.method]
  if (!handler) {
    return { id: req.id, error: { code: ErrorCode.BAD_REQUEST, message: `unsupported method: ${req.method}` } }
  }
  const t0 = Date.now()
  let tabBefore: number | null = null
  let outcome: Outcome
  try {
    await Promise.all([sessions.loadSessions(), control.ready(), activity.ready()])
    const existing = sessions.findSession(req.session)
    if (req.method === "tab.close" && typeof req.params.id === "number") tabBefore = req.params.id
    else if (req.method !== "tab.new") tabBefore = existing?.activeTabId ?? null
    // Before any session is created: a paused request must leave no trace but its activity entry.
    if (!WHILE_PAUSED.has(req.method)) control.assertNotPaused()
    if (actsInTab(req.method) || READS_TAB.has(req.method)) {
      // Loads the recording state for the tab lock's check; refuse early for the tab the call names or the active one.
      await recorder.ready()
      const target = req.method === "act.batch" && typeof req.params.tab === "number" ? req.params.tab : tabBefore
      if (target !== null) recorder.assertNotRecorded(target)
    }
    const s = CREATES_SESSION.has(req.method)
      ? sessions.getOrCreateSession(req.session)
      : (existing ?? sessions.emptySession(req.session))
    const result = await handler(req.params, s)
    outcome = { result: result === undefined ? null : result }
  } catch (e) {
    outcome = { error: errorOf(e) }
  }
  if (isRecorded(req.method)) {
    await recordActivity(req, tabBefore, Date.now() - t0, outcome).catch((e: unknown) =>
      console.warn("[kite] activity not recorded", e),
    )
  }
  return { id: req.id, ...outcome } as RpcResponse
}
