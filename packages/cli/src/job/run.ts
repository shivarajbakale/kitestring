import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Method } from "@kitestring/protocol"
import { RowSet, type Row } from "../client/collect.js"
import { formatOf, serialize, toTable } from "../client/extract.js"
import { KiteError } from "../client/rpc-client.js"
import { runScript, type ScriptResult } from "../script/run.js"
import { compileSpec } from "./spec.js"
import {
  appendLog,
  appendRows,
  loadJob,
  readLog,
  readRows,
  readState,
  readStatus,
  writeState,
  writeStatus,
  type JobDef,
  type JobStatus,
} from "./store.js"

export type JobCall = (method: Method, params: Record<string, unknown>, session: string, timeoutMs: number) => Promise<unknown>

export interface RunJobOpts {
  /** Ends the run early (SIGTERM from `kite job stop`): rows so far are saved. */
  signal?: AbortSignal
  /** No notification at the end (a schedule tells the person itself). */
  quiet?: boolean
  /** Upload paths a script passes: refused in a job (nobody vets them there). */
  resolveFiles?: (files: string[]) => string[]
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The session a job's calls run in (its readEach workers: `<session>~r<n>`). */
export const jobSession = (id: string): string => `job-${id}`

/** Writes every row the job kept to its `save` file (format from the extension); the path. */
export function saveJobRows(home: string, def: JobDef, file = def.save): string | undefined {
  if (!file) return undefined
  const rows = readRows(home, def.id)
  writeFileSync(file, serialize(toTable(rows), formatOf(file)), { mode: 0o600 })
  return file
}

/**
 * Runs a job to its end in this process: opens its tab (a window in front when it clicks or scrolls), runs its script
 * with rows streaming to rows.jsonl (each once, by its row id), checkpoints to state.json, and logs to log.txt. A run
 * after the first resumes: rows already kept are not added again and the script gets its last checkpoint as `resume`.
 * At the end the rows go to the `save` file, the tab closes (an error leaves a front window open to look at) and the
 * person gets a notification.
 */
export async function runJob(home: string, id: string, call: JobCall, o: RunJobOpts = {}): Promise<JobStatus> {
  const def = loadJob(home, id)
  const before = readStatus(home, id)
  const session = jobSession(id)
  const kept = readRows(home, id)
  const seen = new RowSet(def.rowId)
  seen.remember(kept)
  const status: JobStatus = { state: "running", pid: process.pid, startedAt: new Date().toISOString(), rows: seen.size, runs: (before?.runs ?? 0) + 1 }
  writeStatus(home, id, status)
  appendLog(home, id, [`run ${status.runs} started${kept.length ? ` (resuming with ${kept.length} rows)` : ""}`])
  let lastWrite = 0
  const progress = (force = false) => {
    if (!force && Date.now() - lastWrite < 1_000) return
    lastWrite = Date.now()
    writeStatus(home, id, status)
  }
  let tabId: number | undefined
  let r: ScriptResult | undefined
  try {
    if (!def.startUrl) throw new KiteError("BAD_REQUEST", "the job has no page to start on: pass url, or a spec with start")
    const t0 = Date.now()
    tabId = (
      (await call("tab.new", { url: def.startUrl, ...(def.window === "front" ? { own_window: true } : { background: true }) }, session, 30_000)) as { id: number }
    ).id
    const code = def.kind === "spec" ? compileSpec(def.spec!) : def.code!
    r = await runScript(code, {
      call: (m, p, t) => call(m, p, session, t),
      worker: (n) => (m, p, t) => call(m, p, `${session}~r${n}`, t),
      timeoutMs: Math.max(10_000, def.timeoutMs - (Date.now() - t0)),
      resolveFiles: o.resolveFiles ?? (() => {
        throw new KiteError("BAD_REQUEST", "a job cannot upload files")
      }),
      params: def.params,
      resume: readState(home, id),
      sink: {
        seen,
        write: (rows: Row[]) => {
          appendRows(home, id, rows)
          status.rows = seen.size
          progress()
        },
        checkpoint: (state) => writeState(home, id, state),
      },
      ...(def.window === "front"
        ? {
            waitVisible: {
              onHidden: () => {
                status.hidden = true
                progress(true)
                appendLog(home, id, ["waiting: the job's window is hidden (minimized or covered); input resumes once it is in front"])
                void call("notify", { title: `${id} is waiting`, message: "Bring its window to the front: clicks and scrolls need it visible.", ...(tabId !== undefined ? { tab: tabId } : {}) }, session, 5_000).catch(() => {})
              },
            },
          }
        : {}),
      onLog: (line) => appendLog(home, id, [line]),
      ...(o.signal ? { signal: o.signal } : {}),
    })
    // A script that returns its rows instead of emitting them: they are the job's rows.
    if (!r.error && !r.emitted && r.value !== undefined) {
      let v: unknown
      try {
        v = JSON.parse(r.value)
      } catch {
        /* not JSON: kept as the summary */
      }
      if (Array.isArray(v) && v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) appendRows(home, id, seen.add(v as Row[]))
    }
    status.calls = r.calls
    status.rows = seen.size
    if (r.error) {
      status.state = r.error.startsWith("STOPPED") ? "stopped" : "error"
      if (status.state === "error") status.error = r.error
    } else {
      status.state = "done"
      if (r.value !== undefined && !r.value.startsWith("[")) status.summary = r.value.slice(0, 500)
    }
  } catch (e) {
    status.state = o.signal?.aborted ? "stopped" : "error"
    if (status.state === "error") status.error = e instanceof KiteError ? `${e.code}: ${e.message.replace(new RegExp(`^${e.code}: `), "")}` : message(e)
  }
  try {
    status.savedTo = saveJobRows(home, def)
  } catch (e) {
    appendLog(home, id, [`could not write ${def.save}: ${message(e)}`])
  }
  status.endedAt = new Date().toISOString()
  delete status.pid
  delete status.hidden
  writeStatus(home, id, status)
  appendLog(home, id, [`run ${status.runs} ${status.state}: ${status.rows} rows${status.error ? `; ${status.error}` : ""}${status.savedTo ? `; saved to ${status.savedTo}` : ""}`])
  // Its readers' background tabs, whatever state they were left in.
  for (let n = 1; n <= 8; n++) {
    const tabs = ((await call("tab.list", {}, `${session}~r${n}`, 5_000).catch(() => ({ tabs: [] }))) as { tabs?: { id: number }[] }).tabs ?? []
    for (const t of tabs) await call("tab.close", { id: t.id }, `${session}~r${n}`, 5_000).catch(() => {})
  }
  const keepOpen = status.state === "error" && def.window === "front"
  if (tabId !== undefined && !keepOpen) await call("tab.close", { id: tabId }, session, 10_000).catch(() => {})
  if (!o.quiet) {
    const title = status.state === "done" ? `✓ ${id}: ${status.rows} rows` : `${id} ${status.state}`
    const text = status.state === "error" ? (status.error ?? "error") : `${status.rows} rows${status.savedTo ? ` saved to ${status.savedTo}` : ""}`
    await call("notify", { title, message: text.slice(0, 300), ...(keepOpen && tabId !== undefined ? { tab: tabId } : {}) }, session, 5_000).catch(() => {})
  }
  return status
}

/** `dist/bin.js`, from this file's place in dist (`dist/job/run.js`). */
const binPath = (): string => fileURLToPath(new URL("../bin.js", import.meta.url))

/** Starts the job's runner as a process of its own (it outlives this call and the agent), and marks it running. */
export function spawnJob(home: string, id: string): number {
  const child = spawn(process.execPath, [binPath(), "job", "_run", id], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, KITE_HOME: home },
  })
  child.unref()
  const pid = child.pid
  if (pid === undefined) throw new KiteError("INTERNAL", "could not start the job's process")
  const before = readStatus(home, id)
  writeStatus(home, id, { state: "running", pid, startedAt: new Date().toISOString(), rows: before?.rows ?? 0, runs: before?.runs ?? 0 })
  return pid
}

/** Asks a running job to stop; it saves its rows first. False when it is not running. */
export function stopJob(home: string, id: string): boolean {
  loadJob(home, id)
  const st = readStatus(home, id)
  if (st?.state !== "running" || st.pid === undefined) return false
  try {
    process.kill(st.pid, "SIGTERM")
    return true
  } catch {
    return false
  }
}

/** One look at a job: state, rows, the last rows and log lines. */
export function formatJob(home: string, id: string, o: { rows?: number; log?: number } = {}): string {
  const def = loadJob(home, id)
  const st = readStatus(home, id)
  const lines: string[] = []
  const took = st?.startedAt ? Math.round(((st.endedAt ? Date.parse(st.endedAt) : Date.now()) - Date.parse(st.startedAt)) / 1000) : 0
  lines.push(`job ${id}: ${st?.state ?? "not started"}, ${st?.rows ?? 0} rows${took ? `, ${took} s` : ""}${st?.runs && st.runs > 1 ? ` (run ${st.runs})` : ""}${st?.hidden ? "; waiting for its window to be in front" : ""}`)
  if (st?.error) lines.push(`error: ${st.error}`)
  if (st?.summary) lines.push(`→ ${st.summary}`)
  lines.push(`rows: ${home}/jobs/${id}/rows.jsonl${st?.savedTo ? `; saved to ${st.savedTo}` : def.save ? `; saved to ${def.save} at the end` : ""}`)
  const n = o.rows ?? 3
  if (n > 0) {
    const rows = readRows(home, id)
    for (const r of rows.slice(-n)) lines.push(`  ${JSON.stringify(r).slice(0, 400)}`)
  }
  const log = o.log ?? 5
  if (log > 0) {
    for (const l of readLog(home, id, log)) lines.push(`log: ${l.replace(/^\S+ /, "")}`)
  }
  if (st?.state === "error" || st?.state === "stopped") lines.push(`(kite job resume ${id} goes on from its last checkpoint; rows already kept are not added again)`)
  return lines.join("\n")
}
