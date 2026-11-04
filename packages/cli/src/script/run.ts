import { spawn } from "node:child_process"
import type { BatchResult, Method } from "@kitestring/protocol"
import { KiteError } from "../client/rpc-client.js"
import { RowSet, collectList, fieldsReader, readEach, type CollectOpts, type ReadEachOpts, type Row } from "../client/collect.js"
import { parseJsonText } from "../client/scan.js"
import { runProbe } from "../client/probe.js"
import { sandboxMain } from "./sandbox.js"

/** Longest script source accepted. */
export const SCRIPT_MAX_CHARS = 100_000
/** Output kept from console.log, in characters (the rest is dropped with a note). */
const LOG_MAX_CHARS = 200_000
/** A step's time budget is the time left minus this, so its answer arrives before the script's deadline. */
const CALL_MARGIN_MS = 1_000
const BATCH_BUDGET_MAX_MS = 40_000

export type ScriptCall = (method: Method, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>

/** Where `emit` puts rows: kept in memory for a one-off script, written to a file as they come in a job. */
export interface ScriptSink {
  /** Rows kept so far (and how they repeat: by the `id` column, else by every cell). */
  seen: RowSet
  /** Rows not seen before, as they come. */
  write?: (rows: Row[]) => void
  /** `checkpoint(state)`: a job keeps it, and a resumed run gets it back as `resume`. */
  checkpoint?: (state: unknown) => void
}

export interface ScriptOpts {
  call: ScriptCall
  /** Whole-script bound: the child is killed at this deadline. */
  timeoutMs: number
  /** Vets and absolutizes upload paths (the same guard as browser_upload). */
  resolveFiles: (files: string[]) => string[]
  /** A call in worker session `n` (its own tab), for readEach; without it readEach reads by fetch only. */
  worker?: (n: number) => ScriptCall
  /** The script's `params` (a job's or recipe's parameter values). */
  params?: Record<string, string>
  /** The script's `resume`: the state its last run passed to checkpoint (a resumed job), else null. */
  resume?: unknown
  /** Where emitted rows go (default: kept in memory, deduplicated by every cell). */
  sink?: ScriptSink
  /** Before each input step, wait for the tab to be visible (a job in a window of its own); told once when it is not. */
  waitVisible?: { onHidden: () => void }
  /** Each console.log line as it comes (a job's log). */
  onLog?: (text: string) => void
  /** Ends the script (`kite job stop`): its error is STOPPED. */
  signal?: AbortSignal
}

export interface ScriptResult {
  logs: string[]
  /** The script's return value: a string as is, anything else as JSON. */
  value?: string
  error?: string
  timedOut?: boolean
  calls: number
  ms: number
  /** Rows the script passed to emit (each once), when it did. */
  emitted?: Row[]
}

/** waitFor's default and longest wait (the script's own deadline also bounds it). */
const WAIT_DEFAULT_MS = 10_000
const WAIT_MAX_MS = 120_000
const WAIT_UNTIL = ["load", "domcontentloaded", "idle"] as const

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

  /** Set once the script has ended (done, failed, timed out or stopped): helpers still running in here stop at their next call. */
  let ended = false
  const over = () => new KiteError("STOPPED", "the script has ended")
  const callFor = (method: Method, params: Record<string, unknown>) => {
    // Closing a tab is cleanup: it still goes after the end.
    if (ended && method !== "tab.close") return Promise.reject(over())
    calls++
    return opts.call(method, params, Math.max(1_000, remaining()))
  }
  const sink: ScriptSink = opts.sink ?? { seen: new RowSet() }
  let emittedAny = false
  const emitRows = (rows: Row[]): { added: number; total: number } => {
    if (ended) return { added: 0, total: sink.seen.size }
    emittedAny = true
    const fresh = sink.seen.add(rows)
    if (fresh.length) sink.write?.(fresh)
    return { added: fresh.length, total: sink.seen.size }
  }
  let toldHidden = false
  /** A job's window can be covered or minimized: input then never lands, so wait for it to be visible again. */
  const beforeInput = async () => {
    if (!opts.waitVisible) return
    for (;;) {
      let hidden = false
      try {
        // A wait whose function is true at once reads the state without an entry in the activity log (page.eval has one).
        hidden = ((await callFor("page.wait", { cond: { fn: "() => document.visibilityState" }, timeout_ms: 1_000 })) as { value?: unknown }).value === "hidden"
      } catch {
        return // the step itself says what is wrong
      }
      if (!hidden) return
      if (!toldHidden) {
        toldHidden = true
        opts.waitVisible.onHidden()
      }
      if (remaining() < 10_000) throw new HelperError("HIDDEN", "the tab stayed hidden (its window is minimized or covered): bring it to the front")
      await new Promise((r) => setTimeout(r, 3_000))
    }
  }
  const asRows = (v: unknown, what: string): Row[] => {
    const list = Array.isArray(v) ? v : [v]
    if (list.some((r) => r === null || typeof r !== "object" || Array.isArray(r))) throw new KiteError("BAD_REQUEST", `${what} takes a row object or an array of them`)
    return list as Row[]
  }
  const reader = (fn: unknown): string => {
    if (fn === "auto" || (fn && typeof fn === "object" && !Array.isArray(fn))) return fieldsReader(fn as Record<string, string> | "auto")
    if (typeof fn === "string" && fn.trim()) return fn
    throw new KiteError("BAD_REQUEST", 'readEach needs a function (doc, url) => row, a {name: "css"} field map, or "auto"')
  }
  const step = async (s: Record<string, unknown>, o: unknown): Promise<Record<string, unknown>> => {
    if (s.action !== "goto") await beforeInput()
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
    goto: (url, o) => {
      const { waitUntil, ...rest } = (o ?? {}) as { waitUntil?: unknown }
      if (waitUntil !== undefined && !(WAIT_UNTIL as readonly unknown[]).includes(waitUntil)) {
        throw new KiteError("BAD_REQUEST", `goto waitUntil must be ${WAIT_UNTIL.join(", ")}`)
      }
      return step({ action: "goto", url: str(url, "goto url"), ...(waitUntil !== undefined ? { wait_until: waitUntil } : {}) }, rest)
    },
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
    waitFor: async (cond, o) => {
      if (!cond || typeof cond !== "object" || Array.isArray(cond)) {
        throw new KiteError("BAD_REQUEST", "waitFor needs a condition: {selector}, {target}, {text}, {count}, {url}, {fn} or {idle: true}")
      }
      const timeout = (o as { timeout?: unknown } | undefined)?.timeout ?? WAIT_DEFAULT_MS
      if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 0 || timeout > WAIT_MAX_MS) {
        throw new KiteError("BAD_REQUEST", `waitFor timeout must be a whole number of ms, 0..${WAIT_MAX_MS}`)
      }
      // Never past the script's own deadline (minus time to answer).
      const ms = Math.max(0, Math.min(timeout, remaining() - CALL_MARGIN_MS))
      const r = (await callFor("page.wait", { cond, timeout_ms: ms })) as { ms: number; value?: unknown }
      return r.value !== undefined ? r.value : true
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
    emit: async (rows) => emitRows(asRows(rows, "emit")),
    checkpoint: async (state) => {
      const text = JSON.stringify(state ?? null)
      if (text.length > 1_000_000) throw new KiteError("BAD_REQUEST", "checkpoint state must be under 1 MB of JSON")
      sink.checkpoint?.(JSON.parse(text))
      return true
    },
    collect: async (o) => {
      const { emit, ...rest } = (o ?? {}) as CollectOpts & { emit?: boolean }
      const r = await collectList((m, p) => callFor(m, p), rest, {
        deadline,
        beforeInput,
        ...(emit ? { onRows: (rows: Row[]) => void emitRows(rows), seen: sink.seen } : {}),
      })
      if (r.stopped) addLog(`collect: ${r.rows.length} rows, ${r.rounds} round${r.rounds === 1 ? "" : "s"}; ${r.stopped}`)
      return r.rows
    },
    readEach: async (urls, fn, o) => {
      if (!Array.isArray(urls)) throw new KiteError("BAD_REQUEST", "readEach needs an array of URLs (or of rows, with link naming their URL column)")
      const { emit, link: linkOpt, ...rest } = (o ?? {}) as ReadEachOpts & { emit?: boolean; link?: string }
      const mode = rest.mode ?? (opts.worker ? "tab" : "fetch")
      if (mode === "tab" && !opts.worker) throw new KiteError("BAD_REQUEST", 'readEach in tabs is not available here: pass mode: "fetch"')
      // Rows (from collect) in place of URLs: each is read at its link column, and the page's fields join the row.
      const base = urls.length && urls.every((u) => u !== null && typeof u === "object" && !Array.isArray(u)) ? (urls as Row[]) : undefined
      const link = linkOpt ?? "link"
      const list = base ? base.map((r) => r[link]).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)) : urls.map(String)
      const byUrl = new Map(base?.map((r) => [r[link] as string, r]))
      const join = (row: Row): Row => {
        const b = byUrl.get(row.url as string)
        if (!b) return row
        const { url: _u, ...rest2 } = row
        return { ...b, ...rest2 }
      }
      const id = sink.seen.id
      const key = base ? link : "url"
      let ok = 0
      let failed = 0
      const rows = await readEach(
        list,
        reader(fn),
        { ...rest, mode },
        {
          main: (m, p) => callFor(m, p),
          worker: (n) => (m, p) => {
            if (ended && m !== "tab.close") return Promise.reject(over())
            calls++
            return opts.worker!(n)(m, p, Math.max(1_000, remaining()))
          },
          deadline,
          onRow: (row) => {
            const bad = row.error !== undefined && Object.keys(row).length === 2
            if (bad) failed++
            else ok++
            if (emit && !bad) emitRows([join(row)])
          },
          // A resumed job does not read again the pages it already has (its rows repeat by their URL).
          ...(emit && id === key ? { skip: (url: string) => sink.seen.has({ [key]: url }) } : {}),
        },
      )
      addLog(`readEach: ${ok} read${failed ? `, ${failed} failed` : ""}${rows.length < list.length ? `, ${list.length - rows.length} not read` : ""}`)
      return rows.map(join)
    },
    fetchJson: async (url, init) => {
      const u = str(url, "fetchJson url")
      const expr = `(async () => { const r = await fetch(${JSON.stringify(u)}, Object.assign({ credentials: "include" }, ${JSON.stringify(init ?? {})})); const t = await r.text(); return { status: r.status, text: t } })()`
      const r = ((await callFor("page.eval", { expression: expr })) as { value?: { status: number; text: string } }).value
      if (!r) throw new HelperError("ERROR", `fetchJson ${u}: no answer`)
      if (r.status >= 400) throw new HelperError(`HTTP_${r.status}`, `fetchJson ${u}: HTTP ${r.status}`, { status: r.status })
      const v = parseJsonText(r.text)
      return v === undefined ? r.text : v
    },
    responses: async (o) => {
      const { filter, limit, since } = (o ?? {}) as { filter?: unknown; limit?: unknown; since?: unknown }
      const net = (await callFor("page.network", { bodies: true, body_max: 0, limit: 500, ...(typeof filter === "string" && filter ? { filter } : {}) })) as {
        entries: { bodyId?: number; url: string; method: string; status?: number }[]
      }
      const want = net.entries.filter((e) => e.bodyId !== undefined && (typeof since !== "number" || e.bodyId > since))
      const out: unknown[] = []
      for (const e of want.slice(-(typeof limit === "number" && limit > 0 ? limit : 20))) {
        try {
          const b = (await callFor("page.network", { body: e.bodyId })) as { body: string }
          const json = parseJsonText(b.body)
          out.push({ id: e.bodyId, url: e.url, method: e.method, status: e.status, ...(json !== undefined ? { json } : { text: b.body }) })
        } catch {
          /* the body was dropped since */
        }
      }
      return out
    },
    probe: async () => runProbe((m, p) => callFor(m, p)),
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
    opts.onLog?.(text)
    if (logChars >= LOG_MAX_CHARS) return
    logChars += text.length
    logs.push(logChars > LOG_MAX_CHARS ? `${text.slice(0, text.length - (logChars - LOG_MAX_CHARS))}\n… (output cut at ${LOG_MAX_CHARS} characters)` : text)
  }

  return new Promise<ScriptResult>((resolve) => {
    let finished = false
    const finish = (r: Partial<ScriptResult>) => {
      if (finished) return
      finished = true
      ended = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      resolve({ logs, calls, ms: Date.now() - t0, ...(emittedAny ? { emitted: sink.seen.rows } : {}), ...r })
    }
    const timer = setTimeout(() => finish({ timedOut: true, error: `TIMEOUT: script ran past ${opts.timeoutMs} ms` }), Math.max(0, opts.timeoutMs))
    if (opts.signal?.aborted) finish({ error: "STOPPED: stopped on request" })
    opts.signal?.addEventListener("abort", () => finish({ error: "STOPPED: stopped on request" }), { once: true })
    const reply = (m: object) => {
      if (!finished && child.connected) child.send(m)
    }
    child.on("message", (m: any) => {
      switch (m?.type) {
        case "ready":
          return reply({ type: "run", code, params: opts.params ?? {}, resume: opts.resume ?? null })
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
  if (r.emitted && r.value === undefined) lines.push(`emitted ${r.emitted.length} row${r.emitted.length === 1 ? "" : "s"}`)
  if (r.value !== undefined) lines.push(`→ ${r.value}`)
  if (r.error) lines.push(`error: ${r.error}`)
  lines.push(`(${r.calls} browser call${r.calls === 1 ? "" : "s"}, ${r.ms} ms)`)
  return lines.join("\n")
}
