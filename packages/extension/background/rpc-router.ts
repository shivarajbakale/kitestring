import {
  ErrorCode,
  RpcRequest,
  parseBatchParams,
  type ActionResult,
  type ActivityEntry,
  type Method,
  type RpcResponse,
  type Target,
} from "@kitestring/protocol"
import * as activity from "./activity"
import { callAgent } from "./agent-bridge"
import * as capture from "./capture"
import * as control from "./control"
import { RestrictedPageError, RpcError } from "./errors"
import { runBatch } from "./batch"
import { goto, runAction } from "./pipeline"
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
  status: async () => ({ connected: true, sessions: sessions.sessionNames(), paused: control.isPaused() }),

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

  "tab.new": async (params, s) => {
    const url = params.url
    if (url !== undefined && typeof url !== "string") badRequest("params.url must be a string")
    const t = await sessions.newTab(s, url)
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

  "act.scroll": async (params, s) => {
    const direction = params.direction
    if (direction !== "up" && direction !== "down") badRequest('params.direction must be "up" or "down"')
    const px = params.px
    if (px !== undefined && (typeof px !== "number" || !Number.isFinite(px) || px <= 0)) {
      badRequest("params.px must be a positive number")
    }
    return runAction(s, { kind: "scroll", direction, ...(px !== undefined ? { px } : {}) })
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
])

/** Methods that change something: recorded in the activity log, successful or not. */
function isRecorded(m: Method): boolean {
  return (
    m === "tab.new" ||
    m === "tab.close" ||
    m === "page.goto" ||
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
  } else if (req.method === "tab.close") {
    entry.summary = tabBefore === null ? "✓ closed" : `✓ closed tab ${tabBefore}`
  } else {
    const r = outcome.result as ActionResult
    entry.status = r.status
    entry.summary = activity.resultSummary(r)
    entry.diff = r.diff
    entry.page = r.page
    const url = r.navigation?.url ?? (await tabUrl(tabBefore))
    if (url) entry.url = url
  }
  activity.record(entry)
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
