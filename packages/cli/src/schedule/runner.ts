import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Method } from "@kitestring/protocol"
import { KiteError } from "../client/rpc-client.js"
import { runPlan } from "../memory/replay.js"
import { planById } from "../memory/store.js"
import { extractPages, serialize, type Extracted } from "../client/extract.js"
import {
  exportDir,
  loadSchedules,
  needsWindow,
  readWatchText,
  updateSchedule,
  writeWatchText,
  type ExportSchedule,
  type PlanSchedule,
  type Schedule,
  type ScheduleRun,
  type WatchSchedule,
} from "./store.js"

export type SessionCall = (method: Method, params: object, session: string) => Promise<unknown>

/** How often the host looks for due schedules. */
export const TICK_MS = 60_000
/** A due run waits for the person to be away; this late, it runs anyway. */
export const MAX_WAIT_MS = 60 * 60_000

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Where a scheduled run opens its tab: the plan's page, or its site's root when the path holds ids. */
function startUrl(origin: string, pathPattern: string): string {
  return pathPattern.includes("*") ? `${origin}/` : `${origin}${pathPattern}`
}

export interface RunOpts {
  /** Waits between two reads of a watched page (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A run lock older than this is from a process that died mid-run. */
const STALE_LOCK_MS = 15 * 60_000

/**
 * One run of a schedule at a time, across processes (the host's timer and `kite schedule run`): two runs share the
 * session, so one would read the other's tab. Returns the release, or null when another run holds it.
 */
function lockRun(home: string, id: string): (() => void) | null {
  const dir = join(home, "locks")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `schedule-${id}.lock`)
  try {
    if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) rmSync(file, { force: true })
  } catch {
    /* no lock */
  }
  try {
    writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 })
  } catch {
    return null
  }
  return () => rmSync(file, { force: true })
}

/** Runs a schedule once now: replays its plan, or reads its watched page. Skipped while another run of it is on. */
export async function runSchedule(home: string, s: Schedule, call: SessionCall, opts: RunOpts = {}): Promise<ScheduleRun> {
  const release = lockRun(home, s.id)
  if (!release) return { at: new Date().toISOString(), status: "skipped", summary: "another run of it is still going" }
  try {
    return await (s.kind === "watch" ? runWatch(home, s, call, opts) : s.kind === "export" ? runExport(home, s, call, opts) : runPlanSchedule(home, s, call))
  } finally {
    release()
  }
}

/**
 * Replays the schedule's plan in its own session, in a new window in front (Chrome only draws visible windows), then
 * tells the person: a full run closes the window, a stop leaves it there to look at (a click on the notification shows
 * it). Paused: skipped, no notification.
 */
async function runPlanSchedule(home: string, s: PlanSchedule, call: SessionCall): Promise<ScheduleRun> {
  const session = `schedule-${s.id}`
  const at = new Date().toISOString()
  let tabId: number | undefined
  let run: ScheduleRun
  try {
    const { plan } = planById(home, s.plan)
    if (plan.params.some((p) => p.secret)) throw new Error(`plan ${s.plan} now takes a secret: a schedule cannot hold one`)
    tabId = ((await call("tab.new", { url: startUrl(plan.origin, plan.pathPattern), own_window: true }, session)) as { id: number }).id
    const r = await runPlan(plan, s.params, { call: (method, params) => call(method, params, session), home })
    if (r.ok) {
      await call("tab.close", { id: tabId }, session).catch(() => {})
      run = { at, status: "done", summary: `ran ${r.batches} batch${r.batches === 1 ? "" : "es"} in ${(r.ms / 1000).toFixed(1)} s` }
    } else {
      const st = r.stoppedAt!
      run = {
        at,
        status: "stopped",
        summary: `stopped at batch ${st.batch + 1} step ${st.step + 1} (${st.reason}${st.stepText ? `: ${st.stepText}` : ""})${st.detail ? ` ${st.detail}` : ""}`,
      }
    }
  } catch (e) {
    if (e instanceof KiteError && e.code === "PAUSED") return { at, status: "skipped", summary: "Kitestring was paused" }
    run = { at, status: "error", summary: message(e) }
  }
  const title = run.status === "done" ? `✓ ${s.id}` : `${s.id} stopped`
  await call("notify", { title, message: run.summary, ...(run.status !== "done" && tabId !== undefined ? { tab: tabId } : {}) }, session).catch(() => {})
  return run
}

/** A watched page's lines as compared run to run: trimmed, blank and ignored ones left out. */
export function watchLines(text: string, ignore: string[] = []): string[] {
  const res = ignore.map((r) => new RegExp(r, "i"))
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !res.some((r) => r.test(l)))
}

/** Reads the page until two reads 2 s apart agree (content that loads late), at most 5 reads. */
async function settledText(read: () => Promise<string>, sleep: (ms: number) => Promise<void>): Promise<string> {
  let last = await read()
  for (let i = 0; i < 4; i++) {
    await sleep(2_000)
    const next = await read()
    if (next === last) return next
    last = next
  }
  return last
}

/** A watch confirms a change with a second read this much later. */
const CONFIRM_MS = 5_000

const quote = (l: string) => JSON.stringify(l.length > 80 ? `${l.slice(0, 79)}…` : l)

/** Up to three lines that say something (not counters or separators like "1", "(1)", "·"), quoted. */
function examples(lines: string[]): string {
  const telling = lines.filter((l) => /\p{L}{3}/u.test(l))
  return (telling.length ? telling : lines).slice(0, 3).map(quote).join(", ")
}

/**
 * Reads the watched page in a background tab of its own session (reading works there; only input needs a visible
 * window), keeps its text, and tells the person when lines were added or removed since the last run: a click on the
 * notification opens the page. The first run only keeps the text. No change: no notification. An error is told once,
 * not again while it repeats. Paused: skipped.
 */
async function runWatch(home: string, s: WatchSchedule, call: SessionCall, opts: RunOpts): Promise<ScheduleRun> {
  const session = `schedule-${s.id}`
  const at = new Date().toISOString()
  let tabId: number | undefined
  let run: ScheduleRun
  try {
    tabId = ((await call("tab.new", { url: s.url, background: true }, session)) as { id: number }).id
    const sleep = opts.sleep ?? sleepMs
    const read = async () => watchLines(await settledText(async () => ((await call("page.text", {}, session)) as { text: string }).text, sleep), s.ignore)
    let lines = await read()
    const before = readWatchText(home, s.id)
    if (before === undefined) {
      // A first read can miss parts drawn late: a second read 5 s later adds what it shows, so they are no change later.
      await sleep(CONFIRM_MS)
      const have = new Set(lines)
      lines = [...lines, ...(await read()).filter((l) => !have.has(l))]
      writeWatchText(home, s.id, lines.join("\n"))
      run = { at, status: "done", summary: `first read: kept ${lines.length} lines; you hear when they change` }
    } else {
      const was = new Set(before.split("\n").filter(Boolean))
      let added = lines.filter((l) => !was.has(l))
      const first = new Set(lines)
      let removed = [...was].filter((l) => !first.has(l))
      if (added.length || removed.length) {
        // Parts of busy pages draw late or come and go: only a change a second read 5 s later still shows counts.
        await sleep(CONFIRM_MS)
        const again = await read()
        const seen = new Set(again)
        added = added.filter((l) => seen.has(l))
        removed = removed.filter((l) => !seen.has(l))
        // The new baseline takes only confirmed changes: a line that flickered stays as it was, so it is no change next time.
        const gone = new Set(removed)
        lines = [...again.filter((l) => was.has(l) || added.includes(l)), ...[...was].filter((l) => !seen.has(l) && !gone.has(l))]
      }
      writeWatchText(home, s.id, lines.join("\n"))
      run =
        added.length || removed.length
          ? {
              at,
              status: "changed",
              summary: `+${added.length} −${removed.length} lines${added.length ? `: ${examples(added)}` : `, gone: ${examples(removed)}`}`,
            }
          : { at, status: "done", summary: "no change" }
    }
  } catch (e) {
    if (e instanceof KiteError && e.code === "PAUSED") run = { at, status: "skipped", summary: "Kitestring was paused" }
    else run = { at, status: "error", summary: message(e) }
  } finally {
    if (tabId !== undefined) await call("tab.close", { id: tabId }, session).catch(() => {})
  }
  const tell =
    run.status === "changed" ? `${s.id} changed` : run.status === "error" && s.last?.status !== "error" ? `${s.id}: could not read the page` : run.summary.startsWith("first read") ? `Watching ${s.id}` : null
  if (tell) await call("notify", { title: tell, message: run.summary, url: s.url }, session).catch(() => {})
  return run
}

const rowKey = (r: Record<string, string>) => JSON.stringify(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))

/**
 * Reads the page's rows (paging with `next`) and writes them to `exports/<id>/<time>.<format>`, then tells the person
 * how many rows are new since the last run (a click opens the page). Paging clicks need a window in front;
 * a one-page read runs in a background tab. The first read waits for the rows to settle. Paused: skipped.
 */
async function runExport(home: string, s: ExportSchedule, call: SessionCall, opts: RunOpts): Promise<ScheduleRun> {
  const session = `schedule-${s.id}`
  const at = new Date().toISOString()
  const sleep = opts.sleep ?? sleepMs
  let tabId: number | undefined
  let run: ScheduleRun
  try {
    tabId = ((await call("tab.new", { url: s.url, ...(s.next ? { own_window: true } : { background: true }) }, session)) as { id: number }).id
    const c = (method: Method, params: Record<string, unknown>) => call(method, params, session)
    const choose = { ...(s.near ? { near: s.near } : {}), ...(s.selector ? { selector: s.selector } : {}) }
    // Rows drawn late: read until two reads 2 s apart count the same (a page still loading has none yet), at most 5 reads.
    let last = -1
    for (let i = 0; i < 5; i++) {
      let n = -1
      try {
        n = ((await c("page.extract", { ...choose, max: 1 })) as { total: number }).total
      } catch (e) {
        if (!(e instanceof KiteError && e.code === "BAD_REQUEST") || i === 4) throw e
      }
      if (n >= 0 && n === last) break
      last = n
      await sleep(2_000)
    }
    const x: Extracted = await extractPages(c, { ...choose, ...(s.next ? { next: s.next } : {}), ...(s.pages ? { pages: s.pages } : {}), ...(s.max ? { max: s.max } : {}), ...(s.columns ? { columns: s.columns } : {}), ...(s.rowId ? { id: s.rowId } : {}) }, sleep)
    const dir = exportDir(home, s.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const file = join(dir, `${at.replace(/:/g, "-").replace(/\.\d+Z$/, "Z")}.${s.format}`)
    writeFileSync(file, serialize(x, s.format), { mode: 0o600 })
    const lastFile = join(dir, ".last-rows.json")
    let before: Set<string> | undefined
    try {
      before = new Set(JSON.parse(readFileSync(lastFile, "utf8")) as string[])
    } catch {
      /* first run */
    }
    const keys = x.rows.map((r) => (s.rowId && r[s.rowId] ? `id:${r[s.rowId]}` : rowKey(r)))
    const fresh = before ? keys.filter((k) => !before.has(k)).length : undefined
    writeFileSync(`${lastFile}.tmp`, JSON.stringify(keys), { mode: 0o600 })
    renameSync(`${lastFile}.tmp`, lastFile)
    run = {
      at,
      status: fresh ? "changed" : "done",
      summary: `${x.rows.length} rows${fresh !== undefined ? ` (${fresh} new)` : ""} saved to ${file}${x.stopped ? `; ${x.stopped}` : ""}`,
    }
  } catch (e) {
    if (e instanceof KiteError && e.code === "PAUSED") run = { at, status: "skipped", summary: "Kitestring was paused" }
    else run = { at, status: "error", summary: message(e) }
  } finally {
    if (tabId !== undefined) await call("tab.close", { id: tabId }, session).catch(() => {})
  }
  if (run.status !== "skipped" && (run.status !== "error" || s.last?.status !== "error")) {
    const title = run.status === "error" ? `${s.id}: could not save the rows` : `${s.id}: ${run.summary.split(" saved to ")[0]}`
    await call("notify", { title, message: run.summary, url: s.url }, session).catch(() => {})
  }
  return run
}

/**
 * Runs every due schedule once, one at a time. A plan (or a paging export) runs while the person is `away`, or once it is
 * MAX_WAIT_MS late (its window opens in front of what they are doing); a watch or one-page export runs when due. The next run is booked before this one starts, so a crash never loops it.
 */
export async function runDue(home: string, call: SessionCall, away: boolean, now = Date.now()): Promise<string[]> {
  const ran: string[] = []
  for (const s of loadSchedules(home)) {
    // Reading alone works in a background tab: only runs that click or scroll wait for the person to be away.
    if (s.nextAt > now || (needsWindow(s) && !away && now - s.nextAt < MAX_WAIT_MS)) continue
    updateSchedule(home, s.id, { nextAt: now + s.everyMs })
    updateSchedule(home, s.id, { last: await runSchedule(home, s, call) })
    ran.push(s.id)
  }
  return ran
}

/**
 * The host's loop: every TICK_MS, when the extension answers, runs the due schedules (see runDue; a locked screen is not
 * away: Chrome may not draw then). Ticks never overlap. Returns stop.
 */
export function startScheduler(home: string, call: SessionCall, log: (m: string) => void, tickMs = TICK_MS): () => void {
  let busy = false
  const tick = async () => {
    if (busy || !loadSchedules(home).length) return
    busy = true
    try {
      // Throws while the extension is not connected: try at the next tick.
      const st = (await call("status", {}, "scheduler")) as { idle?: string }
      const ran = await runDue(home, call, st.idle === "idle")
      if (ran.length) log(`schedules ran: ${ran.join(", ")}`)
    } catch (e) {
      log(`scheduler: ${message(e)}`)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), tickMs)
  timer.unref()
  return () => clearInterval(timer)
}
