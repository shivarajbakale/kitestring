import { KiteError } from "../client/rpc-client.js"
import {
  CHOICE_ROLES,
  paramName,
  parseTarget,
  pathPattern,
  type BatchResult,
  type Plan,
  type PlanParam,
  type PlanStep,
  type PlanTarget,
  type ReplayStep,
  type Step,
  type Target,
} from "@kitestring/protocol"

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g
const RAN_OK = new Set(["done", "no_effect"])
const MIN_ECHO = 3

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim()
const base = (f: string): string => f.split(/[\\/]/).pop() ?? f

interface Echo {
  norm: string
  /** `"<batch>.<step>"` of the step that supplied it (a step's own value is not an echo in its own target). */
  owner: string
  param?: string
}

/**
 * Turns the batches an agent sent (and what happened) into a parameterized plan.
 *
 * - Keeps only steps that ran ok (`done` / `no_effect`); halted, skipped and unreached steps are dropped.
 * - Every fill/select value and upload file becomes `{{param}}`, named from the target (`title`, `title_2`, ...).
 *   A single printable-character `press` becomes a param too (OTP pads); named keys and modifier combos stay literal.
 * - No value may survive in any stored string. The echo set is every fill/select value and upload basename of the whole
 *   run (ok or not), compared case-insensitively with whitespace collapsed. A target `text`/`within` that equals or
 *   contains an entry of 3+ characters, a goto path segment that does, and any `expect` that does, are replaced by that
 *   value's `{{param}}` (expect is dropped). Clicks on option / menuitemradio / treeitem / gridcell targets pick a value, so
 *   their text becomes `{{<within or role>}}`, and the picked text joins the echo set (as does a select's chosen visible
 *   text, `StepResult.chosen`). Radio and checkbox labels stay literal: they are page structure.
 * - `goto` loses its query and fragment; the stored step gets `droppedQuery: true`.
 * - Targets are written from `StepResult.resolved` as `{text, role, within?}`. Without it, a text target is stored with the
 *   step's own `within`/`role` folded in; an `@ref` target without `resolved` throws.
 * - A fill/select/upload target whose name echoes any value (its own included) stores no such text: the target is
 *   `{role, within?}` (a RoleStep; one with no role throws `cannot store step <b>.<i>: no role`). Replay halts at a role-only
 *   step and hands the page to the agent. Its param is named from the role.
 * - Steps are copied field by field per action (an allowlist), so unknown keys never reach the plan.
 * - `secrets` holds `"<batch>.<step>"` (zero-based positions in `sent`) of fields that were password / cc-* / one-time-code.
 */
export function buildPlan(intent: string, url: string, sent: Step[][], results: BatchResult[], secrets: Set<string>): Plan {
  const params: PlanParam[] = []
  const used = new Set<string>()
  const newParam = (label: string, secret: boolean): string => {
    const b = paramName(label)
    let name = b
    for (let n = 2; used.has(name); n++) name = `${b}_${n}`
    used.add(name)
    params.push({ name, secret })
    return name
  }

  const ran = (b: number, i: number): boolean => RAN_OK.has(results[b]?.steps[i]?.status ?? "")
  const echoes: Echo[] = []
  sent.forEach((steps, b) =>
    steps.forEach((s, i) => {
      const owner = `${b}.${i}`
      const add = (v: string) => norm(v).length >= MIN_ECHO && echoes.push({ norm: norm(v), owner })
      const r = results[b]?.steps[i]
      if (s.action === "fill" || s.action === "select") add(s.value)
      else if (s.action === "upload") s.files.forEach((f) => add(base(f)))
      // what was picked is a value too: a select's chosen text, and an option-like click's name (as the recorder does)
      if (s.action === "select" && r?.chosen) add(r.chosen)
      if (s.action === "click" && r?.resolved && CHOICE_ROLES.has(r.resolved.role) && ran(b, i)) add(r.resolved.name)
    }),
  )
  const hit = (text: string, owner: string): Echo | undefined => {
    const n = norm(text)
    let best: Echo | undefined
    for (const e of echoes) if (e.owner !== owner && n.includes(e.norm) && (!best || e.norm.length > best.norm.length)) best = e
    return best
  }
  /** `{{param}}` for the echoed value, allocating a param lazily when the supplying step was not kept. */
  const echoParam = (e: Echo, label: string): string => (e.param ??= newParam(label, false))
  const clean = (text: string, owner: string, label: string): string => {
    const e = hit(text, owner)
    return e ? `{{${echoParam(e, label)}}}` : text
  }
  const echoed = (text: string): boolean => echoes.some((e) => norm(text).includes(e.norm))

  // pass 1: params of the kept fill/select/upload/press steps, in order
  const own = new Map<string, string>()
  sent.forEach((steps, b) =>
    steps.forEach((s, i) => {
      if (!ran(b, i)) return
      const r = results[b]!.steps[i]!
      let label: string | undefined
      if (s.action === "fill" || s.action === "select" || s.action === "upload") {
        const t = r.resolved?.name ?? (typeof s.target === "string" ? s.target : "text" in s.target ? s.target.text : "")
        label = echoed(t) ? (r.resolved?.role ?? "value") : t
      } else if (s.action === "press" && s.key.length === 1 && !s.key.includes("+")) label = "key"
      if (label === undefined) return
      const name = newParam(label, secrets.has(`${b}.${i}`))
      own.set(`${b}.${i}`, name)
      for (const e of echoes) if (e.owner === `${b}.${i}`) e.param ??= name
    }),
  )

  const batches: PlanStep[][] = []
  sent.forEach((steps, b) => {
    const kept: PlanStep[] = []
    steps.forEach((step, i) => {
      if (!ran(b, i)) return
      const id = `${b}.${i}`
      const r = results[b]!.steps[i]!
      const out: Record<string, unknown> = {}
      for (const k of ["wait", "if_present", "dialog"] as const) if (step[k] !== undefined) out[k] = step[k]
      if (step.expect && !echoed("text" in step.expect ? step.expect.text : step.expect.url)) out.expect = step.expect
      out.action = step.action

      if ("target" in step) {
        let target: PlanTarget
        if (r.resolved) {
          target = { text: r.resolved.name, role: r.resolved.role, ...(r.resolved.within ? { within: r.resolved.within } : {}) }
        } else {
          const t = typeof step.target === "string" ? parseTarget(step.target, { within: step.within, role: step.role }) : step.target
          if ("ref" in t) throw new Error(`batch ${b} step ${i}: cannot store an @ref target without a resolved name`)
          target = { text: t.text, ...((t.role ?? step.role) ? { role: t.role ?? step.role } : {}), ...((t.within ?? step.within) ? { within: t.within ?? step.within } : {}) }
        }
        if (step.action === "fill" || step.action === "select" || step.action === "upload") {
          // a field named after a value (its own or another) must not store that name: role (+ clean scope) only
          const { text, within, role } = target as { text: string; within?: string; role?: string }
          if (text && echoed(text)) {
            if (!role) throw new Error(`cannot store step ${id}: no role`)
            target = { role, ...(within && !echoed(within) ? { within } : {}) }
          } else {
            target = { text, ...(role ? { role } : {}), ...(within && !echoed(within) ? { within } : {}) }
          }
        } else if ("text" in target) {
          const label = target.role ?? "value"
          const choice = step.action === "click" && target.role !== undefined && CHOICE_ROLES.has(target.role)
          const e = hit(target.text, id)
          const scope = target.within && !echoed(target.within) ? target.within : target.role
          let text = target.text
          if (e) text = `{{${echoParam(e, label)}}}`
          else if (choice) {
            // the pick's own echo (its name) shares its param, so a later step naming it replays the same value
            const p = echoes.find((x) => x.owner === id && x.param)?.param ?? newParam(scope!, false)
            for (const x of echoes) if (x.owner === id) x.param ??= p
            text = `{{${p}}}`
          }
          target = { ...target, text, ...(target.within ? { within: clean(target.within, id, label) } : {}) }
        }
        out.target = target
      }
      switch (step.action) {
        case "goto": {
          const { url: u, dropped } = cleanUrl(step.url, (seg) => clean(seg, id, "url"))
          out.url = u
          if (dropped) out.droppedQuery = true
          break
        }
        case "fill":
        case "select":
          out.value = `{{${own.get(id)}}}`
          break
        case "upload":
          out.files = [`{{${own.get(id)}}}`]
          break
        case "press":
          out.key = own.has(id) ? `{{${own.get(id)}}}` : step.key
          break
        case "scroll":
          out.direction = step.direction
          if (step.px !== undefined) out.px = step.px
          break
        case "switch_tab":
          out.to = step.to
          break
        case "wait":
          if (step.ms !== undefined) out.ms = step.ms
          break
      }
      kept.push(out as unknown as PlanStep)
    })
    batches.push(kept)
  })

  let origin = url
  try {
    origin = new URL(url).origin
  } catch {
    /* keep the raw text */
  }
  const pattern = pathPattern(url)
    .split("/")
    .map((seg) => (seg && echoed(decodeSeg(seg)) ? "*" : seg))
    .join("/")
  return {
    version: 1,
    intent,
    origin,
    pathPattern: pattern,
    params,
    batches: batches.filter((x) => x.length),
    createdAt: new Date().toISOString(),
    runs: 0,
    lastOk: null,
  }
}

function safeSegment(v: string): string {
  const e = encodeURIComponent(v)
  return e === "." || e === ".." ? e.replace(/\./g, "%2E") : e
}

function decodeSeg(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/** The URL without query / fragment and with echoing path segments replaced by `clean`'s result. */
function cleanUrl(raw: string, clean: (seg: string) => string): { url: string; dropped: boolean } {
  let head = raw
  let tail = ""
  let prefix = ""
  try {
    const u = new URL(raw)
    prefix = u.origin
    head = u.pathname
    tail = u.search + u.hash
  } catch {
    const at = raw.search(/[?#]/)
    if (at >= 0) {
      head = raw.slice(0, at)
      tail = raw.slice(at)
    }
  }
  const path = head
    .split("/")
    .map((seg) => (seg ? clean(decodeSeg(seg)) : seg))
    .join("/")
  return { url: prefix + path, dropped: tail.length > 1 }
}

/**
 * The plan's batches with every `{{param}}` replaced by `values[param]`. Throws `missing parameters: a, b` listing all, and
 * BAD_REQUEST for an upload whose files are not each exactly one `{{param}}`.
 */
export function fillPlan(plan: Plan, values: Record<string, string>): ReplayStep[][] {
  const missing = plan.params.map((p) => p.name).filter((n) => !Object.hasOwn(values, n))
  if (missing.length) throw new Error(`missing parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`)
  const sub = (s: string): string => s.replace(PLACEHOLDER, (m, name: string) => (Object.hasOwn(values, name) ? values[name]! : m))
  return plan.batches.map((steps) =>
    steps.map((s) => {
      const { droppedQuery: _d, ...rest } = s
      const c = rest as Record<string, unknown>
      for (const k of ["value", "key"]) if (typeof c[k] === "string") c[k] = sub(c[k] as string)
      if (typeof c.url === "string") {
        // a value in a URL is one path segment: never a way to change host, path depth or query
        let substituted = false
        const url: string = c.url.replace(PLACEHOLDER, (m, name: string) => {
          if (!Object.hasOwn(values, name)) return m
          substituted = true
          return safeSegment(values[name]!)
        })
        c.url = url
        let same = false
        try {
          same = new URL(url).origin === plan.origin
        } catch {
          /* not absolute */
        }
        // a recorded goto is replayed as recorded; only a URL a parameter flowed into must stay on the plan's origin
        if (substituted && !same) throw new KiteError("BAD_REQUEST", `refusing goto ${url}: not on ${plan.origin}`)
      }
      if (Array.isArray(c.files)) {
        // upload files come only from params: a stored path (a hand-edited plan) is never uploaded
        if (!(c.files as string[]).every((f) => /^\{\{[a-z0-9_]+\}\}$/.test(f))) {
          throw new KiteError("BAD_REQUEST", "refusing upload step: every file must be one {{param}}")
        }
        c.files = (c.files as string[]).map(sub)
      }
      if (c.target && typeof c.target === "object" && "text" in c.target) {
        const t = c.target as { text: string; within?: string }
        c.target = { ...t, text: sub(t.text), ...(t.within ? { within: sub(t.within) } : {}) }
      }
      return c as unknown as ReplayStep
    }),
  )
}

