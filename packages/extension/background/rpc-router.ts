import { ErrorCode, RpcRequest, type Method, type RpcResponse } from "@bx/protocol"
import { callAgent } from "./agent-bridge"
import { RestrictedPageError, RpcError } from "./errors"
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
