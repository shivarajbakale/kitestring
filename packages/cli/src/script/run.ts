import { spawn } from "node:child_process"
import type { BatchResult, Method } from "@kitestring/protocol"
import { KiteError } from "../client/rpc-client.js"
import { sandboxMain } from "./sandbox.js"

/** Longest script source accepted. */
export const SCRIPT_MAX_CHARS = 100_000
/** Output kept from console.log, in characters (the rest is dropped with a note). */
const LOG_MAX_CHARS = 200_000
/** A step's time budget is the time left minus this, so its answer arrives before the script's deadline. */
const CALL_MARGIN_MS = 1_000
const BATCH_BUDGET_MAX_MS = 40_000

export interface ScriptOpts {
  call: (method: Method, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>
  /** Whole-script bound: the child is killed at this deadline. */
  timeoutMs: number
  /** Vets and absolutizes upload paths (the same guard as browser_upload). */
  resolveFiles: (files: string[]) => string[]
}

export interface ScriptResult {
  logs: string[]
  /** The script's return value: a string as is, anything else as JSON. */
  value?: string
  error?: string
  timedOut?: boolean
  calls: number
  ms: number
}

/** Step options a helper passes through to its batch step. */
const STEP_OPTS = ["within", "role", "wait", "if_present", "expect", "dialog"] as const

function stepOpts(o: unknown): Record<string, unknown> {
  if (o === undefined || o === null) return {}
  if (typeof o !== "object") throw new KiteError("BAD_REQUEST", "options must be an object")
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (!(STEP_OPTS as readonly string[]).includes(k)) throw new KiteError("BAD_REQUEST", `unknown option ${k} (known: ${STEP_OPTS.join(", ")})`)
    if (v !== undefined) out[k] = v
  }
  return out
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || !v) throw new KiteError("BAD_REQUEST", `${what} must be a non-empty string`)
  return v
}

/** A failed helper: the code and message the script's catch sees, plus fields it can inspect. */
class HelperError extends Error {
  constructor(
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

/**
 * Runs agent-written JavaScript in a sandboxed Node child. Browser helpers become Kitestring calls; each action
 * is a one-step batch that does not wait for the page to go idle (`wait_idle: "never"`): it waits for its target
 * to appear and its `expect` to come true, so the script says what it waits for.
 */
export async function runScript(code: string, opts: ScriptOpts): Promise<ScriptResult> {
  const t0 = Date.now()
  const deadline = t0 + opts.timeoutMs
  const remaining = () => deadline - Date.now()
  const logs: string[] = []
  let logChars = 0
  let calls = 0

  const callFor = (method: Method, params: Record<string, unknown>) => {
    calls++
    return opts.call(method, params, Math.max(1_000, remaining()))
  }
  const step = async (s: Record<string, unknown>, o: unknown): Promise<Record<string, unknown>> => {
    const budget = Math.min(BATCH_BUDGET_MAX_MS, remaining() - CALL_MARGIN_MS)
    const r = (await callFor("act.batch", { steps: [{ ...s, ...stepOpts(o) }], wait_idle: "never", budget_ms: budget })) as BatchResult
    const st = r.steps[0]
    if (!r.ok) {
      const reason = r.halted?.reason ?? st?.status ?? "error"
      const detail = r.halted?.detail ?? st?.detail ?? ""
      throw new HelperError(reason.toUpperCase(), `${s.action}: ${detail || reason}`, {
        status: st?.status ?? reason,
        ...(r.candidates ? { candidates: r.candidates.map((c) => c.line) } : {}),
        ...(r.blockedBy ? { blockedBy: r.blockedBy } : {}),
      })
    }
    return {
      status: st?.status ?? "done",
      ...(st?.chosen !== undefined ? { chosen: st.chosen } : {}),
      ...(r.navigation ? { url: r.navigation.url, title: r.navigation.title } : {}),
      ...(r.newTabs?.length ? { newTabs: r.newTabs } : {}),
      ...(r.dialogs?.length ? { dialogs: r.dialogs } : {}),
    }
  }

  const ops: Record<string, (...a: any[]) => Promise<unknown>> = {
    goto: (url, o) => step({ action: "goto", url: str(url, "goto url") }, o),
    click: (target, o) => step({ action: "click", target: str(target, "click target") }, o),
    fill: (target, value, o) => step({ action: "fill", target: str(target, "fill target"), value: String(value ?? "") }, o),
    select: (target, value, o) => step({ action: "select", target: str(target, "select target"), value: String(value ?? "") }, o),
    press: (key, o) => step({ action: "press", key: str(key, "press key") }, o),
    scroll: (direction, px) => {
      if (direction !== "up" && direction !== "down") throw new KiteError("BAD_REQUEST", 'scroll direction must be "up" or "down"')
      return step({ action: "scroll", direction, ...(px !== undefined ? { px } : {}) }, undefined)
    },
    upload: (target, files, o) => {
      if (!Array.isArray(files) || !files.length) throw new KiteError("BAD_REQUEST", "upload files must be a non-empty array of paths")
      return step({ action: "upload", target: str(target, "upload target"), files: opts.resolveFiles(files.map(String)) }, o)
    },
    waitFor: (cond, o) => {
      const c = cond as { text?: unknown; url?: unknown } | undefined
      const expect = typeof c?.text === "string" ? { text: c.text } : typeof c?.url === "string" ? { url: c.url } : undefined
      if (!expect) throw new KiteError("BAD_REQUEST", "waitFor needs {text} or {url}")
      const timeout = (o as { timeout?: unknown } | undefined)?.timeout
      if (timeout !== undefined && (typeof timeout !== "number" || timeout < 0 || timeout > 10_000)) {
        throw new KiteError("BAD_REQUEST", "waitFor timeout must be 0..10000 ms")
      }
      return step({ action: "wait", ms: 0, expect, wait: timeout ?? 5_000 }, undefined)
    },
    snapshot: async (o) => {
      const { full, scope } = (o ?? {}) as { full?: unknown; scope?: unknown }
      const r = (await callFor("page.snapshot", { full: full === true, ...(typeof scope === "string" ? { scope } : {}) })) as { text: string }
      return r.text
    },
    text: async (o) => {
      const max = (o as { max?: unknown } | undefined)?.max
      return ((await callFor("page.text", typeof max === "number" ? { max } : {})) as { text: string }).text
    },
    extract: (o) => callFor("page.extract", (o ?? {}) as Record<string, unknown>),
    evaluate: async (expression) => ((await callFor("page.eval", { expression: str(expression, "evaluate expression") })) as { value?: unknown }).value,
    tabs: async () => ((await callFor("tab.list", {})) as { tabs: unknown[] }).tabs,
    newTab: (url) => callFor("tab.new", typeof url === "string" && url ? { url } : {}),
    useTab: (id) => callFor("tab.use", { id }),
    closeTab: (id) => callFor("tab.close", typeof id === "number" ? { id } : {}),
  }

  const flag = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission"
  const child = spawn(process.execPath, [flag, "--max-old-space-size=256", "-e", `(${sandboxMain.toString()})()`], {
    env: {},
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const stderr: string[] = []
  child.stdout!.setEncoding("utf8").on("data", (d: string) => addLog(d.replace(/\n$/, "")))
  child.stderr!.setEncoding("utf8").on("data", (d: string) => void stderr.push(d))

  function addLog(text: string) {
    if (logChars >= LOG_MAX_CHARS) return
    logChars += text.length
    logs.push(logChars > LOG_MAX_CHARS ? `${text.slice(0, text.length - (logChars - LOG_MAX_CHARS))}\n… (output cut at ${LOG_MAX_CHARS} characters)` : text)
  }

  return new Promise<ScriptResult>((resolve) => {
    let finished = false
    const finish = (r: Partial<ScriptResult>) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      resolve({ logs, calls, ms: Date.now() - t0, ...r })
    }
    const timer = setTimeout(() => finish({ timedOut: true, error: `TIMEOUT: script ran past ${opts.timeoutMs} ms` }), Math.max(0, opts.timeoutMs))
    const reply = (m: object) => {
      if (!finished && child.connected) child.send(m)
    }
    child.on("message", (m: any) => {
      switch (m?.type) {
        case "ready":
          return reply({ type: "run", code })
        case "log":
          return addLog(String(m.text))
        case "call": {
          const op = ops[m.op]
          if (!op) return reply({ type: "reply", id: m.id, ok: false, error: { code: "BAD_REQUEST", message: `unknown helper ${m.op}` } })
          void (async () => op(...(Array.isArray(m.args) ? m.args : [])))().then(
            (value) => reply({ type: "reply", id: m.id, ok: true, value }),
            (e: unknown) =>
              reply({
                type: "reply",
                id: m.id,
                ok: false,
                error: {
                  code: e instanceof HelperError || e instanceof KiteError ? e.code : "INTERNAL",
                  // Some extension messages already start with their code ("NO_TAB: …"): the script prefixes it once.
                  message: (e instanceof Error ? e.message : String(e)).replace(/^([A-Z_]+): /, (m, c) => (e instanceof KiteError && c === e.code ? "" : m)),
                  ...(e instanceof HelperError ? { extra: e.extra } : {}),
                },
              }),
          )
          return
        }
        case "done":
          return finish(typeof m.value === "string" ? { value: m.value } : {})
        case "fail":
          return finish({ error: String(m.error) })
      }
    })
    child.on("error", (e) => finish({ error: `INTERNAL: could not start the script runner: ${e.message}` }))
    child.on("exit", (codeNum, signal) => {
      const why = stderr.join("").trim().split("\n").slice(-3).join("\n")
      finish({ error: `INTERNAL: script runner exited (${signal ?? `code ${codeNum}`})${why ? `: ${why}` : ""}` })
    })
  })
}

/** What the agent reads: the script's output, its return value or error, and what it cost. */
export function formatScript(r: ScriptResult): string {
  const lines = [...r.logs]
  if (r.value !== undefined) lines.push(`→ ${r.value}`)
  if (r.error) lines.push(`error: ${r.error}`)
  lines.push(`(${r.calls} browser call${r.calls === 1 ? "" : "s"}, ${r.ms} ms)`)
  return lines.join("\n")
}
