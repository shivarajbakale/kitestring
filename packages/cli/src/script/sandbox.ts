/**
 * The child side of `browser_script`. It runs as `node --permission -e "(<this function>)()"`: no files, no
 * subprocesses, no workers and (Node 25+) no network. It must not close over anything outside its own body,
 * since only its source text crosses over. The agent's code gets the helpers below as parameters; each browser
 * helper is one IPC request to the parent, which makes the Kitestring call and answers.
 */
export function sandboxMain(): void {
  const util = require("node:util") as typeof import("node:util")
  const send = (m: unknown) => process.send!(m)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let seq = 0
  const call = (op: string, ...args: unknown[]): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      send({ type: "call", id, op, args })
    })
  const log = (...args: unknown[]) => send({ type: "log", text: util.format(...args) })
  for (const k of ["log", "info", "warn", "error", "debug"] as const) (console as any)[k] = log

  const helpers: Record<string, unknown> = {
    goto: (url: string, opts?: object) => call("goto", url, opts),
    click: (target: string, opts?: object) => call("click", target, opts),
    fill: (target: string, value: string, opts?: object) => call("fill", target, value, opts),
    select: (target: string, value: string, opts?: object) => call("select", target, value, opts),
    press: (key: string, opts?: object) => call("press", key, opts),
    scroll: (direction: string, px?: number) => call("scroll", direction, px),
    upload: (target: string, files: string[], opts?: object) => call("upload", target, files, opts),
    // A function can't cross the IPC channel: send its source.
    waitFor: (cond: any, opts?: object) => call("waitFor", typeof cond?.fn === "function" ? { ...cond, fn: cond.fn.toString() } : cond, opts),
    snapshot: (opts?: object) => call("snapshot", opts),
    text: (opts?: object) => call("text", opts),
    extract: (opts?: object) => call("extract", opts),
    evaluate: (fn: unknown, arg?: unknown) =>
      call("evaluate", typeof fn === "function" ? `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})` : String(fn)),
    tabs: () => call("tabs"),
    newTab: (url?: string) => call("newTab", url),
    useTab: (id: number) => call("useTab", id),
    closeTab: (id?: number) => call("closeTab", id),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0))),
    log,
  }

  process.on("message", (m: any) => {
    if (m?.type === "reply") {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok) p.resolve(m.value)
      else p.reject(Object.assign(new Error(m.error.message), m.error.extra ?? {}, { code: m.error.code }))
      return
    }
    if (m?.type !== "run") return
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    let body: (...a: unknown[]) => Promise<unknown>
    try {
      body = new AsyncFunction(...Object.keys(helpers), m.code)
    } catch (e) {
      send({ type: "fail", error: `SyntaxError: ${(e as Error).message}` })
      return
    }
    body(...Object.values(helpers)).then(
      (v) => {
        let value: string | undefined
        try {
          value = v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v, null, 2)
        } catch {
          value = util.inspect(v, { depth: 4 })
        }
        send({ type: "done", ...(value !== undefined ? { value } : {}) })
      },
      (e) => {
        const err = e as { name?: string; message?: string; code?: string; stack?: string }
        const where = /<anonymous>:(\d+):(\d+)/.exec(err?.stack ?? "")
        // The function wrapper adds two lines above the agent's code.
        const at = where ? ` (line ${Number(where[1]) - 2})` : ""
        const text = e instanceof Error ? `${err.code ? `${err.code}: ` : `${err.name}: `}${err.message}${at}` : `thrown: ${util.inspect(e)}`
        send({ type: "fail", error: text })
      },
    )
  })
  send({ type: "ready" })
}
