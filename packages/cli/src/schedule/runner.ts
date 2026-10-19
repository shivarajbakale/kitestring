import type { Method } from "@kitestring/protocol"
import { KiteError } from "../client/rpc-client.js"
import { runPlan } from "../memory/replay.js"
import { planById } from "../memory/store.js"
import { loadSchedules, readWatchText, updateSchedule, writeWatchText, type PlanSchedule, type Schedule, type ScheduleRun, type WatchSchedule } from "./store.js"

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

/** Runs a schedule once now: replays its plan, or reads its watched page. */
export function runSchedule(home: string, s: Schedule, call: SessionCall, opts: RunOpts = {}): Promise<ScheduleRun> {
  return s.kind === "watch" ? runWatch(home, s, call, opts) : runPlanSchedule(home, s, call)
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

const quote = (l: string) => JSON.stringify(l.length > 80 ? `${l.slice(0, 79)}…` : l)

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
    const text = await settledText(async () => ((await call("page.text", {}, session)) as { text: string }).text, opts.sleep ?? sleepMs)
    const lines = watchLines(text, s.ignore)
    const before = readWatchText(home, s.id)
    writeWatchText(home, s.id, lines.join("\n"))
    if (before === undefined) {
      run = { at, status: "done", summary: `first read: kept ${lines.length} lines; you hear when they change` }
    } else {
      const was = new Set(before.split("\n").filter(Boolean))
      const now = new Set(lines)
      const added = lines.filter((l) => !was.has(l))
      const removed = [...was].filter((l) => !now.has(l))
      run =
        added.length || removed.length
          ? {
              at,
              status: "changed",
              summary: `+${added.length} −${removed.length} lines${added.length ? `: ${quote(added[0]!)}` : `, gone: ${quote(removed[0]!)}`}`,
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

/**
 * Runs every due schedule once, one at a time. A plan runs while the person is `away`, or once it is MAX_WAIT_MS late (its
 * window opens in front of what they are doing); a watch runs when due. The next run is booked before this one starts, so a crash never loops it.
 */
export async function runDue(home: string, call: SessionCall, away: boolean, now = Date.now()): Promise<string[]> {
  const ran: string[] = []
  for (const s of loadSchedules(home)) {
    // A watch only reads, in a background tab: it never waits for the person to be away.
    if (s.nextAt > now || (s.kind !== "watch" && !away && now - s.nextAt < MAX_WAIT_MS)) continue
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
