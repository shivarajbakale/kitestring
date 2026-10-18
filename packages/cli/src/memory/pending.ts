import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { BatchResult, Plan, PlanParam, PlanStep, Step, StepResult } from "@kitestring/protocol"
import { buildPlan } from "./build.js"
import { savePlan } from "./store.js"

/** The journal stops recording past this many stored steps (save or discard to start again). */
export const PENDING_MAX_STEPS = 200

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g
const MIN_ECHO = 3

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
function renameParams(steps: PlanStep[], map: Map<string, string>): PlanStep[] {
  if (![...map].some(([a, b]) => a !== b)) return steps
  return JSON.parse(JSON.stringify(steps).replace(PLACEHOLDER, (m, n: string) => (map.has(n) ? `{{${map.get(n)}}}` : m))) as PlanStep[]
}

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
  try {
    const old = read(home, session)
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
    const lead = steps[0]?.action === "goto" ? steps[0].url : url
    const built: Plan = buildPlan("", lead, [ghosts, steps], [ghostResult, result], secrets)

    for (const v of typedValues(steps, result)) if (norm(v).length >= MIN_ECHO) seen.add(hash(salt, norm(v)))

    const kept = built.batches.flat()
    const params = [...(old?.params ?? [])]
    const batches = [...(old?.batches ?? [])]
    const stored = batches.reduce((n, b) => n + b.length, 0)
    if (kept.length && stored + kept.length > PENDING_MAX_STEPS) {
      return `not remembered: pending journal is full (${PENDING_MAX_STEPS} steps); run kite memory save "<intent>" or kite memory discard`
    }
    const used = new Set(params.map((p) => p.name))
    const map = new Map<string, string>()
    for (const p of built.params) {
      let name = p.name
      for (let n = 2; used.has(name); n++) name = `${p.name}_${n}`
      used.add(name)
      map.set(p.name, name)
      params.push({ name, secret: p.secret })
    }
    if (kept.length) batches.push(renameParams(kept, map))

    // the plan starts where the first stored batch started
    const first = !old?.batches.length
    if (first && kept.length && !/^https?:\/\//.test(lead)) return `not remembered: the batch did not start on a web page (${built.origin})`
    write(home, session, {
      version: 1,
      origin: first ? built.origin : old.origin,
      pathPattern: first ? built.pathPattern : old.pathPattern,
      salt,
      seen: [...seen],
      params,
      batches,
    })
    return undefined
  } catch (e) {
    // buildPlan saw this batch as its batch 1 (after the echo batch): name steps 1-based within this batch
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0]!
    return `not remembered: ${msg.replace(/\bbatch 1 step (\d+)/, (_, i: string) => `step ${+i + 1}`).replace(/\bstep 1\.(\d+)/, (_, i: string) => `step ${+i + 1}`)}`
  }
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
 */
export function savePending(home: string, session: string, intent: string): { id: string; plan: Plan } | undefined {
  const p = read(home, session)
  if (!p || !p.batches.length) return undefined
  const plan = planFromPending(intent, p)
  const file = savePlan(home, plan)
  discardPending(home, session)
  return { id: `${basename(dirname(file))}/${basename(file, ".json")}`, plan }
}
