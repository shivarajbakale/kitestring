import type { Method } from "@kitestring/protocol"
import { KiteError } from "../client/rpc-client.js"
import { runPlan } from "../memory/replay.js"
import { planById } from "../memory/store.js"
import { loadSchedules, updateSchedule, type Schedule, type ScheduleRun } from "./store.js"

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

/**
 * Replays the schedule's plan in its own session, in a new window in front (Chrome only draws visible windows), then
 * tells the person: a full run closes the window, a stop leaves it there to look at (a click on the notification shows
 * it). Paused: skipped, no notification.
 */
export async function runSchedule(home: string, s: Schedule, call: SessionCall): Promise<ScheduleRun> {
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

/**
 * Runs every due schedule once, one at a time: while the person is `away`, or once a run is MAX_WAIT_MS late (its window
 * opens in front of what they are doing). The next run is booked before this one starts, so a crash never loops it.
 */
export async function runDue(home: string, call: SessionCall, away: boolean, now = Date.now()): Promise<string[]> {
  const ran: string[] = []
  for (const s of loadSchedules(home)) {
    if (s.nextAt > now || (!away && now - s.nextAt < MAX_WAIT_MS)) continue
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
