import { homedir } from "node:os"
import type { BatchResult, HaltReason, Method, Plan, PlanStep, ReplayStep, Step } from "@kitestring/protocol"
import { KiteError } from "../client/rpc-client.js"
import { kiteHome } from "../paths.js"
import { resolveUploads } from "../upload-guard.js"
import { fillPlan } from "./build.js"
import { savePlan } from "./store.js"

export type RpcCall = (method: Method, params: object) => Promise<unknown>

/** Why a replay stopped: a batch halt, a missing parameter, or a role-only step only the agent can place. */
export type ReplayStopReason = HaltReason | "missing_param" | "needs_agent" | "wrong_page"

export interface ReplayResult {
  ok: boolean
  /** act.batch calls sent (in a dry run: batches printed). */
  batches: number
  ms: number
  /** Zero-based batch / step of the plan where the replay stopped; `stepText` is the stored step (never a value). */
  stoppedAt?: { batch: number; step: number; reason: ReplayStopReason; detail: string; stepText: string }
  missing?: string[]
  /** The last batch's result (the halted one when stopped): the page the agent takes over from. */
  result?: BatchResult
  /** Steps the action cache served. */
  cached?: number
}

export interface ReplayDeps {
  call: RpcCall
  /** One line for the user (notes; dry-run batches). */
  out?: (s: string) => void
  /** Print the filled batches (secrets as ••••) and send nothing. */
  dryRun?: boolean
  /** Extra params to mask in a dry run (passed as secrets by the user). */
  secretNames?: Set<string>
  /** $KITE_HOME (default kiteHome()). */
  home?: string
  /** Called once, right before the first call to the browser (not in a dry run, not when params are refused). */
  onStart?: () => void
  /**
   * Called when a started replay stops short: with `stoppedAt` on a returned stop, or `{batch, step: 0}` of the batch in
   * flight when a browser call throws (the error is rethrown). Not called for a full run.
   */
  onStop?: (at: { batch: number; step: number }) => void
}

export const NEEDS_AGENT_DETAIL = "field name not stored (it matched a typed value)"
const MASK = "••••"

function originOf(url: string): string | undefined {
  try {
    const o = new URL(url).origin
    return o === "null" ? undefined : o
  } catch {
    return undefined
  }
}

const isRoleStep = (s: ReplayStep): boolean =>
  "target" in s && typeof s.target === "object" && !("text" in s.target) && !("ref" in s.target)

/** The stored step as a short label: its target text quoted, or what it does. Never a filled value. */
export function stepText(s: PlanStep): string {
  if ("target" in s && typeof s.target === "object") {
    if ("text" in s.target) return JSON.stringify(s.target.text)
    if ("role" in s.target) return `${s.action} ${s.target.role}${s.target.within ? ` in ${s.target.within}` : ""}`
  }
  switch (s.action) {
    case "goto":
      return `goto ${s.url}`
    case "press":
      return `press ${s.key}`
    case "scroll":
      return `scroll ${s.direction}`
    case "switch_tab":
      return `switch_tab ${s.to}`
    default:
      return s.action
  }
}

/**
 * Replays a stored plan with `values`, one `act.batch` per stored batch, stopping at the first halt with the page left
 * there for the agent. Before each batch the active tab must be on the plan's origin (else `wrong_page`, nothing sent),
 * unless the batch opens with a goto to that origin. Nothing is sent until every parameter checks out: an unknown name is `BAD_REQUEST`; missing names
 * return `{ok: false, missing}` listing all of them. Upload files come only from `values` and pass the upload deny list.
 * A role-only step (its field name matched a typed value) is never sent: the replay stops before it with `needs_agent`.
 * A risky click halts inside `act.batch` and is never continued. Only a fully ok run bumps the plan's `runs` / `lastOk`.
 */
export async function runPlan(plan: Plan, values: Record<string, string>, deps: ReplayDeps): Promise<ReplayResult> {
  const t0 = Date.now()
  const out = deps.out ?? (() => {})
  const names = plan.params.map((p) => p.name)
  const unknown = Object.keys(values).filter((k) => !names.includes(k))
  const missing = names.filter((n) => !Object.hasOwn(values, n))
  const missingText = `missing parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`
  if (unknown.length) {
    throw new KiteError(
      "BAD_REQUEST",
      `unknown parameter${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (plan takes: ${names.join(", ") || "none"})` +
        (missing.length ? `; ${missingText}` : ""),
    )
  }
  if (missing.length) {
    const detail = missingText
    return { ok: false, batches: 0, ms: Date.now() - t0, missing, stoppedAt: { batch: 0, step: 0, reason: "missing_param", detail, stepText: "" } }
  }

  const filled = fillPlan(plan, values)
  const guard = { cwd: process.cwd(), home: homedir(), kiteHome: deps.home ?? kiteHome(), env: process.env }
  for (const steps of filled) for (const s of steps) if (s.action === "upload") s.files = resolveUploads(s.files, guard)

  if (deps.dryRun) {
    const secret = new Set([...plan.params.filter((p) => p.secret).map((p) => p.name), ...(deps.secretNames ?? [])])
    const masked = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, secret.has(k) ? MASK : v]))
    fillPlan(plan, masked).forEach((steps, b) => out(`batch ${b + 1}: ${JSON.stringify(steps)}`))
    return { ok: true, batches: filled.length, ms: Date.now() - t0 }
  }

  let sent = 0
  let cached = 0
  let last: BatchResult | undefined
  deps.onStart?.()
  let current = 0
  let stopped: ReplayResult | undefined
  try {
    stopped = await (async (): Promise<ReplayResult | undefined> => {
      for (let b = 0; b < filled.length; b++) {
        current = b
        const steps = filled[b]!
        const stored = plan.batches[b]!
        // values only ever go to the plan's own site: check the tab first, unless the batch opens by going there
        const lead = steps[0]
        if (!(lead?.action === "goto" && originOf(lead.url) === plan.origin)) {
          const tabs = (await deps.call("tab.list", {})) as { tabs?: { url?: string; active?: boolean }[] } | null
          const on = originOf(tabs?.tabs?.find((t) => t.active)?.url ?? "")
          if (on !== plan.origin) {
            return {
              ok: false,
              batches: sent,
              ms: Date.now() - t0,
              stoppedAt: { batch: b, step: 0, reason: "wrong_page", detail: `tab is on ${on ?? "no web page"}, plan is for ${plan.origin}`, stepText: stored[0] ? stepText(stored[0]) : "" },
              ...(last ? { result: last } : {}),
              cached,
            }
          }
        }
        const roleAt = steps.findIndex(isRoleStep)
        const send = (roleAt < 0 ? steps : steps.slice(0, roleAt)) as Step[]
        if (send.length) {
          send.forEach((s, i) => {
            const p = stored[i]!
            if (p.action === "goto" && p.droppedQuery) out(`note: query string was not stored for ${p.url}`)
          })
          const r = (await deps.call("act.batch", { steps: send })) as BatchResult
          sent++
          last = r
          cached += r.steps.filter((s) => s.cached).length
          if (!r.ok) {
            const step = r.halted?.index ?? r.next ?? r.steps.length
            return {
              ok: false,
              batches: sent,
              ms: Date.now() - t0,
              stoppedAt: { batch: b, step, reason: r.halted?.reason ?? "error", detail: r.halted?.detail ?? "", stepText: stored[step] ? stepText(stored[step]) : "" },
              result: r,
              cached,
            }
          }
        }
        if (roleAt >= 0) {
          return {
            ok: false,
            batches: sent,
            ms: Date.now() - t0,
            stoppedAt: { batch: b, step: roleAt, reason: "needs_agent", detail: NEEDS_AGENT_DETAIL, stepText: stepText(stored[roleAt]!) },
            ...(last ? { result: last } : {}),
            cached,
          }
        }
      }
      return undefined
    })()
  } catch (e) {
    // the page is somewhere inside batch `current`: the takeover redoes it from its start
    deps.onStop?.({ batch: current, step: 0 })
    throw e
  }
  if (stopped) {
    deps.onStop?.({ batch: stopped.stoppedAt!.batch, step: stopped.stoppedAt!.step })
    return stopped
  }

  try {
    savePlan(deps.home ?? kiteHome(), { ...plan, runs: 1, lastOk: new Date().toISOString() })
  } catch (e) {
    out(`note: run not recorded in memory: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { ok: true, batches: sent, ms: Date.now() - t0, cached, ...(last ? { result: last } : {}) }
}
