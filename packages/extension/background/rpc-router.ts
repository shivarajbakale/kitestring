import { ErrorCode, RpcRequest, type Method, type RpcResponse, type Target } from "@bx/protocol"
import { callAgent } from "./agent-bridge"
import { RestrictedPageError, RpcError } from "./errors"
import { goto, runAction } from "./pipeline"
import * as sessions from "./sessions"

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

const handlers: Partial<Record<Method, Handler>> = {
  status: async () => ({ connected: true, sessions: sessions.sessionNames() }),

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
    const text = await callAgent<string>(sessions.activeTab(s), "snapshot", [
      { full: params.full === true, ...(scope !== undefined ? { scope } : {}) },
    ])
    return { text }
  },

  "page.goto": async (params, s) => goto(s, stringParam(params, "url")),

  "act.click": async (params, s) => runAction(s, { kind: "click", target: targetParam(params) }),

  "act.fill": async (params, s) =>
    runAction(s, { kind: "fill", target: targetParam(params), value: stringParam(params, "text") }),

  "act.select": async (params, s) =>
    runAction(s, { kind: "select", target: targetParam(params), value: stringParam(params, "value") }),

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
  try {
    await sessions.loadSessions()
    const s = CREATES_SESSION.has(req.method)
      ? sessions.getOrCreateSession(req.session)
      : (sessions.findSession(req.session) ?? sessions.emptySession(req.session))
    const result = await handler(req.params, s)
    return { id: req.id, result: result === undefined ? null : result }
  } catch (e) {
    if (e instanceof RestrictedPageError) return { id: req.id, error: { code: ErrorCode.RESTRICTED, message: e.message } }
    if (e instanceof RpcError) return { id: req.id, error: { code: e.code, message: e.message } }
    return { id: req.id, error: { code: ErrorCode.INTERNAL, message: e instanceof Error ? e.message : String(e) } }
  }
}
