import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { BatchResult, Plan, PlanParam, PlanStep, Step, StepResult } from "@kitestring/protocol"
import { buildPlan } from "./build.js"
import { MATCH_THRESHOLD, intentScore, planById, savePlan } from "./store.js"

/** The journal stops recording past this many stored steps (save or discard to start again). */
export const PENDING_MAX_STEPS = 200

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g
const MIN_ECHO = 3
/** A batch this long after the journal's last one starts a new task memory. */
export const NEW_TASK_AFTER_MS = 30 * 60_000

/** What a session's agent did since its last save / discard, parameterized: no values. */
export interface Pending {
  origin: string
  pathPattern: string
  params: PlanParam[]
  batches: PlanStep[][]
}

interface PendingFile extends Pending {
  version: 1
  /** Random per file; salts `seen`. */
  salt: string
  /** sha256(salt + value) of every whitespace-collapsed, lowercased non-secret value of 3+ characters typed so far. */
  seen: string[]
  /** When the last batch was journaled (ISO). */
  updatedAt: string
  /** The last journaled batch halted: a resend of its ok steps is not journaled twice. */
  tailHalted?: boolean
  /** The journal began where a replay of this plan (`<origin-slug>/<plan-slug>`) stopped: saving stitches it on. */
  fromPlan?: string
  stoppedAt?: { batch: number; step: number }
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim()
const base = (f: string): string => f.split(/[\\/]/).pop() ?? f
const hash = (salt: string, v: string): string => createHash("sha256").update(salt).update("\0").update(v).digest("hex")

const pendingDir = (home: string): string => join(home, "memory", ".pending")
/** One file per session; the name is made safe so a session can never point outside the directory. */
const pendingFile = (home: string, session: string): string =>
  join(pendingDir(home), `${session.replace(/[^A-Za-z0-9_-]/g, "_") || "_"}.json`)

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

function read(home: string, session: string): PendingFile | undefined {
  try {
    const p = JSON.parse(readFileSync(pendingFile(home, session), "utf8")) as PendingFile
    return p.version === 1 && Array.isArray(p.batches) && Array.isArray(p.seen) ? p : undefined
  } catch {
    return undefined
  }
}

function write(home: string, session: string, p: PendingFile): void {
  ensureDir(join(home, "memory"))
  ensureDir(pendingDir(home))
  const file = pendingFile(home, session)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(p) + "\n", { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/** Every string of a step that may end up stored as page structure: target / scope names, goto path segments, expects. */
function structureTexts(step: Step, r: StepResult | undefined): string[] {
  const out: string[] = []
  const s = step as Step & { target?: unknown }
  if (typeof s.target === "string") out.push(s.target)
  else if (s.target && typeof s.target === "object" && "text" in s.target) {
    const t = s.target as { text: string; within?: string }
    out.push(t.text)
    if (t.within) out.push(t.within)
  }
  if (step.within) out.push(step.within)
  if (r?.resolved) {
    out.push(r.resolved.name)
    if (r.resolved.within) out.push(r.resolved.within)
  }
  if (step.action === "goto") {
    let path = step.url.split(/[?#]/)[0] ?? ""
    try {
      path = new URL(step.url).pathname
    } catch {
      /* relative: the part before ? / # */
    }
    for (const seg of path.split("/")) {
      if (!seg) continue
      try {
        out.push(decodeURIComponent(seg))
      } catch {
        out.push(seg)
      }
    }
  }
  if (step.expect) out.push("text" in step.expect ? step.expect.text : step.expect.url)
  return out
}

/**
 * The values a batch typed (as buildPlan's echo set sees them), except secret fields': a fast hash of a password next to its
 * salt could be brute-forced, and a secret is never shown back as page structure.
 */
function typedValues(steps: Step[], result: BatchResult): string[] {
  const out: string[] = []
  for (const [i, s] of steps.entries()) {
    if (result.steps[i]?.secret) continue
    if (s.action === "fill" || s.action === "select") out.push(s.value)
    else if (s.action === "upload") for (const f of s.files) out.push(base(f))
  }
  return out
}

/** `steps` with every `{{name}}` renamed by `map`. */
function renameParams<T>(steps: T, map: Map<string, string>): T {
  if (![...map].some(([a, b]) => a !== b)) return steps
  return JSON.parse(JSON.stringify(steps).replace(PLACEHOLDER, (m, n: string) => (map.has(n) ? `{{${map.get(n)}}}` : m))) as T
}

/** Param names referenced by `x`. */
function referenced(x: unknown): Set<string> {
  return new Set([...JSON.stringify(x).matchAll(PLACEHOLDER)].map((m) => m[1]!))
}

/** Appends `add` to `params` (mutated), renaming on a clash (`name_2`); returns the renames. */
function addParams(params: PlanParam[], add: PlanParam[]): Map<string, string> {
  const used = new Set(params.map((p) => p.name))
  const map = new Map<string, string>()
  for (const p of add) {
    let name = p.name
    for (let n = 2; used.has(name); n++) name = `${p.name}_${n}`
    used.add(name)
    map.set(p.name, name)
    params.push({ name, secret: p.secret })
  }
  return map
}

/** A step's shape with param names blanked, to compare a resent step with the journaled one. */
const shape = (s: PlanStep): string => JSON.stringify(s).replace(PLACEHOLDER, "{{}}")

function originOf(url: string): string | undefined {
  try {
    const o = new URL(url).origin
    return o === "null" ? undefined : o
  } catch {
    return undefined
  }
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`

/**
 * Journals one `act.batch` the agent sent through `kite batch` / `browser_batch`, parameterized by `buildPlan` (its ok steps
 * only; no value is ever written). Secret params come from `StepResult.secret`. `url` is the tab's URL when the batch began
 * (`BatchResult.startUrl`); a batch that opens with a goto starts at that goto's URL instead. The first stored batch sets the
 * plan's origin and path pattern.
 *
 * Each batch is built on its own, so values typed in earlier batches are known only as salted SHA-256 hashes: a target name,
 * scope, expect or goto path segment of this batch whose normalized whole text hashes to one of them is treated as an echo of
 * a value whose step was not kept (a `{{param}}` named from the role; a fill / select / upload target goes role-only), the
 * same way buildPlan treats echoes. Param names stay unique across batches (`name`, `name_2`).
 *
 * Memory never fails the user's batch: anything that cannot be stored returns a one-line note instead of throwing, and the
 * batch is left out.
 */
export function appendPending(home: string, session: string, url: string, steps: Step[], result: BatchResult): string | undefined {
  let fresh: string | undefined
  const say = (note?: string): string | undefined => [fresh, note].filter(Boolean).join("; ") || undefined
  try {
    let old = read(home, session)
    const lead = steps[0]?.action === "goto" ? steps[0].url : url

    // a new task: a batch long after the last one, or on another site, starts over
    if (old) {
      const n = old.batches.reduce((k, b) => k + b.length, 0)
      const leadOrigin = originOf(lead)
      if (!(Date.now() - Date.parse(old.updatedAt) <= NEW_TASK_AFTER_MS)) {
        fresh = `started a new task memory (over 30 min since the last batch${n ? `; dropped ${plural(n, "step")}` : ""})`
        old = undefined
      } else if ((old.batches.length || old.fromPlan) && leadOrigin && leadOrigin !== old.origin) {
        fresh = `started a new task memory (new site ${leadOrigin}${n ? `; dropped ${plural(n, "step")} from ${old.origin}` : ""})`
        old = undefined
      }
    }
    const salt = old?.salt ?? randomBytes(16).toString("hex")
    const seen = new Set(old?.seen ?? [])

    // earlier batches' values named in this batch: fed to buildPlan as values of steps that never ran
    const echoes = new Map<string, string>()
    steps.forEach((s, i) => {
      for (const t of structureTexts(s, result.steps[i])) {
        const n = norm(t)
        if (n.length >= MIN_ECHO && seen.has(hash(salt, n))) echoes.set(n, t)
      }
    })
    const ghosts: Step[] = [...echoes.values()].map((v) => ({ action: "fill", target: "-", value: v }))
    const ghostResult: BatchResult = {
      ok: false,
      steps: ghosts.map((_, i) => ({ i, action: "fill", status: "not_found", ms: 0 })),
      diff: { added: [], removed: [] },
      page: "",
    }
    const secrets = new Set<string>()
    result.steps.forEach((r, i) => r?.secret && secrets.add(`1.${i}`))
    const built: Plan = buildPlan("", lead, [ghosts, steps], [ghostResult, result], secrets)

    for (const v of typedValues(steps, result)) if (norm(v).length >= MIN_ECHO) seen.add(hash(salt, norm(v)))

    let kept = built.batches.flat()
    const params = [...(old?.params ?? [])]
    const batches = [...(old?.batches ?? [])]
    // the agent resent a halted batch from its start: its ok steps are journaled already
    const tail = old?.tailHalted ? batches.at(-1) : undefined
    if (tail) {
      let k = Math.min(tail.length, kept.length)
      while (k > 0 && !kept.slice(0, k).every((st, j) => shape(st) === shape(tail[tail.length - k + j]!))) k--
      kept = kept.slice(k)
    }
    const stored = batches.reduce((n, b) => n + b.length, 0)
    if (kept.length && stored + kept.length > PENDING_MAX_STEPS) {
      return say(`not remembered: pending journal is full (${PENDING_MAX_STEPS} steps); run kite memory save "<intent>" or kite memory discard`)
    }
    const refs = referenced(kept)
    const map = addParams(params, built.params.filter((p) => refs.has(p.name)))
    if (kept.length) batches.push(renameParams(kept, map))

    // the plan starts where the first stored batch started
    const first = !old?.batches.length
    if (first && kept.length && !/^https?:\/\//.test(lead)) return say(`not remembered: the batch did not start on a web page (${built.origin})`)
    write(home, session, {
      version: 1,
      origin: first && !old?.fromPlan ? built.origin : old!.origin,
      pathPattern: first && !old?.fromPlan ? built.pathPattern : old!.pathPattern,
      salt,
      seen: [...seen],
      params,
      batches,
      updatedAt: new Date().toISOString(),
      tailHalted: kept.length ? !result.ok : (old?.tailHalted ?? false),
      ...(old?.fromPlan ? { fromPlan: old.fromPlan, stoppedAt: old.stoppedAt } : {}),
    })
    return say()
  } catch (e) {
    // buildPlan saw this batch as its batch 1 (after the echo batch): name steps 1-based within this batch
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0]!
    return say(`not remembered: ${msg.replace(/\bbatch 1 step (\d+)/, (_, i: string) => `step ${+i + 1}`).replace(/\bstep 1\.(\d+)/, (_, i: string) => `step ${+i + 1}`)}`)
  }
}

/**
 * After a replay of `plan` (id `<origin-slug>/<plan-slug>`) stopped at `stoppedAt`: a fresh journal for the agent's takeover,
 * so that saving it updates the plan (see {@link savePending}). The replay's non-secret values are hashed like typed ones.
 */
export function recordReplayStop(
  home: string,
  session: string,
  id: string,
  plan: Plan,
  stoppedAt: { batch: number; step: number },
  values: Record<string, string> = {},
  /** Params the user passed as secrets (never hashed, like the plan's own secret params). */
  secretNames: Set<string> = new Set(),
): void {
  const salt = randomBytes(16).toString("hex")
  const secret = new Set([...plan.params.filter((p) => p.secret).map((p) => p.name), ...secretNames])
  const seen = Object.entries(values)
    .filter(([k, v]) => !secret.has(k) && norm(v).length >= MIN_ECHO)
    .map(([, v]) => hash(salt, norm(v)))
  write(home, session, {
    version: 1,
    origin: plan.origin,
    pathPattern: plan.pathPattern,
    salt,
    seen,
    params: [],
    batches: [],
    updatedAt: new Date().toISOString(),
    fromPlan: id,
    stoppedAt: { batch: stoppedAt.batch, step: stoppedAt.step },
  })
}

/** The session's journal, removed from disk; undefined when nothing was journaled. */
export function takePending(home: string, session: string): Pending | undefined {
  const p = read(home, session)
  discardPending(home, session)
  if (!p || !p.batches.length) return undefined
  return { origin: p.origin, pathPattern: p.pathPattern, params: p.params, batches: p.batches }
}

/** Deletes the session's journal. False when there was none. */
export function discardPending(home: string, session: string): boolean {
  const file = pendingFile(home, session)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

/** A new plan for `intent` from a journal. */
export function planFromPending(intent: string, p: Pending): Plan {
  return {
    version: 1,
    intent,
    origin: p.origin,
    pathPattern: p.pathPattern,
    params: p.params,
    batches: p.batches,
    createdAt: new Date().toISOString(),
    runs: 0,
    lastOk: null,
  }
}

/**
 * Saves the session's journal as a plan for `intent` and clears the journal (only after the plan is written).
 * Undefined when nothing was journaled. `id` is `<origin-slug>/<plan-slug>`.
 *
 * A journal that began where a replay stopped, saved for the same task (intent overlap >= MATCH_THRESHOLD with the plan's),
 * updates that plan instead (`updated: true`, its intent and slug kept): its batches before the stop, the stopped batch's
 * steps before the stopped step, then the takeover batches, minus the takeover's leading steps that repeat the kept part's
 * last ones (the agent resent the stopped batch whole). Params are those the result still uses, the takeover's renamed on a
 * clash; `createdAt`, `runs` and `lastOk` are kept. Saved for another task, it is a new plan and `note` says the stopped
 * plan is unchanged.
 */
export function savePending(
  home: string,
  session: string,
  intent: string,
): { id: string; plan: Plan; updated?: true; note?: string } | undefined {
  const p = read(home, session)
  if (!p || !p.batches.length) return undefined
  let note: string | undefined
  if (p.fromPlan && p.stoppedAt) {
    let stored
    try {
      stored = planById(home, p.fromPlan)
    } catch {
      /* the plan was forgotten meanwhile: save as a new one */
    }
    if (stored && intentScore(intent, stored.plan.intent) < MATCH_THRESHOLD) {
      note = `saved as a new plan; ${stored.id} unchanged`
      stored = undefined
    }
    if (stored) {
      const { batch, step } = p.stoppedAt
      const done = stored.plan.batches.slice(0, batch)
      const part = stored.plan.batches[batch]?.slice(0, step) ?? []
      if (part.length) done.push(part)
      // a takeover that resent the stopped batch from its start repeats the steps the replay already did
      const [head = [], ...rest] = p.batches
      let k = Math.min(part.length, head.length)
      while (k > 0 && !head.slice(0, k).every((st, j) => shape(st) === shape(part[part.length - k + j]!))) k--
      const takeover = [head.slice(k), ...rest].filter((b) => b.length)
      const refs = referenced(done)
      const params = stored.plan.params.filter((x) => refs.has(x.name))
      const used = referenced(takeover)
      const map = addParams(params, p.params.filter((x) => used.has(x.name)))
      const plan: Plan = { ...stored.plan, params, batches: [...done, ...renameParams(takeover, map)] }
      savePlan(home, { ...plan, runs: 0, lastOk: null }) // merged: keeps createdAt, runs, lastOk
      discardPending(home, session)
      return { id: stored.id, plan, updated: true }
    }
  }
  const plan = planFromPending(intent, p)
  const file = savePlan(home, plan)
  discardPending(home, session)
  return { id: `${basename(dirname(file))}/${basename(file, ".json")}`, plan, ...(note ? { note } : {}) }
}
