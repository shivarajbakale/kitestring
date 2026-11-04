import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { slug } from "@kitestring/protocol"
import type { Spec } from "./spec.js"

/** What a job runs: agent-written code, or a spec (compiled to code). Recipes are the same, saved under a name. */
export interface JobWork {
  kind: "script" | "spec"
  code?: string
  spec?: Spec
  /** Values for the script's `params` (a spec's {placeholders}). */
  params: Record<string, string>
  /** The column rows repeat by (an id, a link): a resumed run and a list read twice add each row once. */
  rowId?: string
  /** Where the run starts: the page it was started from, or the spec's start. */
  startUrl?: string
  /** "front": a window of its own in front (clicks and scrolls need a visible tab); "background": a background tab, reads only. */
  window: "front" | "background"
  timeoutMs: number
}

export interface JobDef extends JobWork {
  id: string
  /** The file the rows are written to at the end (.csv, .json or .jsonl), absolute. Rows also stream to rows.jsonl. */
  save?: string
  /** The recipe it was started from. */
  recipe?: string
  createdAt: string
}

export type JobState = "running" | "done" | "error" | "stopped"

export interface JobStatus {
  state: JobState
  pid?: number
  startedAt: string
  endedAt?: string
  /** Rows kept so far (all runs). */
  rows: number
  calls?: number
  /** The script's return value (a spec's: its row count), or the error. */
  summary?: string
  error?: string
  savedTo?: string
  /** The job's window was hidden and input waits for it (told once). */
  hidden?: boolean
  /** Runs so far (a resume is another run). */
  runs: number
}

export interface Recipe extends JobWork {
  name: string
  /** Format of the file a scheduled run writes. */
  format: "csv" | "json" | "jsonl"
  createdAt: string
}

/** Longest a job may run; its default. */
export const JOB_MAX_MS = 24 * 3_600_000
export const JOB_DEFAULT_MS = 2 * 3_600_000

const dirOf = (home: string, id: string) => join(home, "jobs", id)
export const jobFiles = (home: string, id: string) => {
  const d = dirOf(home, id)
  return { dir: d, def: join(d, "job.json"), status: join(d, "status.json"), rows: join(d, "rows.jsonl"), state: join(d, "state.json"), log: join(d, "log.txt") }
}

function ownerDir(d: string): void {
  mkdirSync(d, { recursive: true, mode: 0o700 })
  chmodSync(d, 0o700)
}

/** Written whole and renamed into place, owner only: rows can be personal. */
function writeJson(file: string, v: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, file)
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

/** A new job's directory with its definition; its id from its recipe (or "job") and the time. */
export function createJob(home: string, def: Omit<JobDef, "id" | "createdAt"> & { name?: string }): JobDef {
  const { name, ...rest } = def
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")
  const base = slug(`${name ?? def.recipe ?? "job"}-${stamp}`, "job")
  let id = base
  for (let n = 2; existsSync(dirOf(home, id)); n++) id = `${base}-${n}`
  const full: JobDef = { ...rest, id, createdAt: new Date().toISOString() }
  ownerDir(join(home, "jobs"))
  ownerDir(dirOf(home, id))
  writeJson(jobFiles(home, id).def, full)
  return full
}

export function loadJob(home: string, id: string): JobDef {
  if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(id)) throw new Error(`not a job id: ${id}`)
  const def = readJson<JobDef>(jobFiles(home, id).def)
  if (!def) throw new Error(`no such job: ${id} (kite job list)`)
  return def
}

export function readStatus(home: string, id: string): JobStatus | undefined {
  const st = readJson<JobStatus>(jobFiles(home, id).status)
  if (st?.state === "running" && st.pid !== undefined && !alive(st.pid)) {
    // The runner died without saying so (killed, the computer slept and restarted).
    return { ...st, state: "error", error: st.error ?? "the job's process ended without finishing (resume it to go on)" }
  }
  return st
}

export function writeStatus(home: string, id: string, st: JobStatus): void {
  writeJson(jobFiles(home, id).status, st)
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Rows the job kept, in order (rows.jsonl, one JSON object per line; a torn last line is skipped). */
export function readRows(home: string, id: string): Record<string, unknown>[] {
  let text = ""
  try {
    text = readFileSync(jobFiles(home, id).rows, "utf8")
  } catch {
    return []
  }
  const out: Record<string, unknown>[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line) as unknown
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>)
    } catch {
      /* a line cut by a crash */
    }
  }
  return out
}

export function appendRows(home: string, id: string, rows: Record<string, unknown>[]): void {
  if (!rows.length) return
  appendFileSync(jobFiles(home, id).rows, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 })
}

export function readState(home: string, id: string): unknown {
  return readJson<{ state: unknown }>(jobFiles(home, id).state)?.state ?? null
}

export function writeState(home: string, id: string, state: unknown): void {
  writeJson(jobFiles(home, id).state, { at: new Date().toISOString(), state })
}

export function appendLog(home: string, id: string, lines: string[]): void {
  if (!lines.length) return
  appendFileSync(jobFiles(home, id).log, lines.map((l) => `${new Date().toISOString()} ${l}`).join("\n") + "\n", { mode: 0o600 })
}

export function readLog(home: string, id: string, lines = 30): string[] {
  try {
    return readFileSync(jobFiles(home, id).log, "utf8").trimEnd().split("\n").slice(-lines)
  } catch {
    return []
  }
}

/** Jobs, newest first. */
export function listJobs(home: string): { def: JobDef; status?: JobStatus }[] {
  let ids: string[] = []
  try {
    ids = readdirSync(join(home, "jobs"))
  } catch {
    return []
  }
  const out: { def: JobDef; status?: JobStatus; t: number }[] = []
  for (const id of ids) {
    const def = readJson<JobDef>(jobFiles(home, id).def)
    if (!def) continue
    let t = 0
    try {
      t = statSync(jobFiles(home, id).def).mtimeMs
    } catch {}
    const status = readStatus(home, id)
    out.push({ def, ...(status ? { status } : {}), t })
  }
  return out.sort((a, b) => b.t - a.t).map(({ t: _t, ...x }) => x)
}

export function removeJob(home: string, id: string): void {
  loadJob(home, id)
  rmSync(dirOf(home, id), { recursive: true, force: true })
}

// ---- recipes: a job saved under a name, to run again with other params or on a schedule

const recipeFile = (home: string, name: string) => join(home, "recipes", `${name}.json`)

export function saveRecipe(home: string, name: string, work: JobWork, format: Recipe["format"] = "csv"): Recipe {
  const n = slug(name, "recipe")
  ownerDir(join(home, "recipes"))
  const r: Recipe = { ...work, name: n, format, createdAt: new Date().toISOString() }
  writeJson(recipeFile(home, n), r)
  return r
}

export function loadRecipe(home: string, name: string): Recipe {
  const r = /^[a-z0-9][a-z0-9-]{0,80}$/.test(name) ? readJson<Recipe>(recipeFile(home, name)) : undefined
  if (!r) throw new Error(`no such recipe: ${name} (kite job recipes)`)
  return r
}

export function listRecipes(home: string): Recipe[] {
  let files: string[] = []
  try {
    files = readdirSync(join(home, "recipes")).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  return files.map((f) => readJson<Recipe>(join(home, "recipes", f))).filter((r): r is Recipe => !!r)
}

export function removeRecipe(home: string, name: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(name) || !existsSync(recipeFile(home, name))) return false
  rmSync(recipeFile(home, name))
  return true
}
