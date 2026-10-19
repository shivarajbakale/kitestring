import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { slug } from "@kitestring/protocol"

/** Something the native host does on its own every `everyMs` while Chrome runs: replay a plan, or watch a page. */
export type Schedule = PlanSchedule | WatchSchedule

/** A saved plan replayed on its own. Schedules from before watches have no `kind`: they are plan schedules. */
export interface PlanSchedule extends ScheduleBase {
  kind?: "plan"
  /** The plan's id, `<site>/<slug>`. */
  plan: string
  /** Every plan param by name. Never a secret: plans with secret params cannot be scheduled. */
  params: Record<string, string>
}

/** A page read on its own; the person hears when its visible text changes. */
export interface WatchSchedule extends ScheduleBase {
  kind: "watch"
  url: string
  /** Lines matching any of these (JS regex source, case-insensitive) are left out: clocks, counters, ads. */
  ignore?: string[]
}

interface ScheduleBase {
  /** Lowercase slug, unique; the run's session is `schedule-<id>`. */
  id: string
  everyMs: number
  /** Epoch ms of the next run; a run missed while Chrome was closed happens once at the next start. */
  nextAt: number
  createdAt: string
  last?: ScheduleRun
}

export interface ScheduleRun {
  at: string
  /** `changed`: a watch saw new text (`done` for a watch: no change, or the first read). */
  status: "done" | "changed" | "stopped" | "skipped" | "error"
  summary: string
}

export const MIN_EVERY_MS = 5 * 60_000
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }

/** "30m", "6h", "1d", "2w" -> ms; at least 5 minutes. */
export function parseEvery(text: string): number {
  const m = /^([1-9]\d*)([mhdw])$/.exec(text.trim())
  if (!m) throw new Error(`interval must look like 30m, 6h, 1d or 1w: ${text}`)
  const ms = Number(m[1]) * UNITS[m[2]!]!
  if (ms < MIN_EVERY_MS) throw new Error(`interval must be at least 5m: ${text}`)
  return ms
}

/** ms -> the largest whole unit: 86400000 -> "1d". */
export function formatEvery(ms: number): string {
  for (const u of ["w", "d", "h", "m"]) if (ms % UNITS[u]! === 0) return `${ms / UNITS[u]!}${u}`
  return `${Math.round(ms / 60_000)}m`
}

const file = (home: string): string => join(home, "schedules.json")

export function loadSchedules(home: string): Schedule[] {
  if (!existsSync(file(home))) return []
  try {
    const list = JSON.parse(readFileSync(file(home), "utf8")) as unknown
    return Array.isArray(list) ? (list as Schedule[]) : []
  } catch {
    return []
  }
}

/** Written whole and renamed into place: the host and the CLI both edit it. Params can be personal: owner only. */
function saveSchedules(home: string, list: Schedule[]): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const tmp = `${file(home)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file(home))
}

type NewSchedule = (Omit<PlanSchedule, "id"> | Omit<WatchSchedule, "id">) & { id?: string }

/** The name a schedule gets when none is given: the plan's slug, or the watched page's host and path. */
function defaultName(s: NewSchedule): string {
  if (s.kind !== "watch") return (s as Omit<PlanSchedule, "id">).plan.split("/").pop() ?? ""
  try {
    const u = new URL(s.url)
    return `${u.host} ${u.pathname}`
  } catch {
    return s.url
  }
}

export function addSchedule(home: string, s: NewSchedule): Schedule {
  const list = loadSchedules(home)
  const base = slug(s.id ?? defaultName(s), "schedule")
  if (s.id !== undefined && list.some((x) => x.id === base)) throw new Error(`a schedule named ${base} already exists`)
  let id = base
  for (let n = 2; list.some((x) => x.id === id); n++) id = `${base}-${n}`
  const out = { ...s, id } as Schedule
  saveSchedules(home, [...list, out])
  return out
}

/** Removes the schedule and, for a watch, the page text it kept. */
export function removeSchedule(home: string, id: string): boolean {
  const list = loadSchedules(home)
  const kept = list.filter((x) => x.id !== id)
  if (kept.length === list.length) return false
  saveSchedules(home, kept)
  rmSync(watchTextFile(home, id), { force: true })
  return true
}

/** Where a watch keeps the page text of its last run (owner-only: it can be a logged-in page). */
export const watchTextFile = (home: string, id: string): string => join(home, "watches", `${id}.txt`)

export function readWatchText(home: string, id: string): string | undefined {
  try {
    return readFileSync(watchTextFile(home, id), "utf8")
  } catch {
    return undefined
  }
}

export function writeWatchText(home: string, id: string, text: string): void {
  const dir = join(home, "watches")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const tmp = `${watchTextFile(home, id)}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, watchTextFile(home, id))
}

/** Patches one schedule on a fresh read (the other process may have edited the file); a removed one stays removed. */
export function updateSchedule(home: string, id: string, patch: Partial<Pick<Schedule, "nextAt" | "last">>): void {
  const list = loadSchedules(home)
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) return
  list[i] = { ...list[i]!, ...patch } as Schedule
  saveSchedules(home, list)
}
