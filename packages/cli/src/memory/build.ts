import { paramName, pathPattern, type BatchResult, type Plan, type PlanParam, type Step } from "@kitestring/protocol"

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g
const RAN_OK = new Set(["done", "no_effect"])

/**
 * Turns the batches an agent sent (and what happened) into a parameterized plan.
 *
 * - Keeps only steps that ran ok (`done` / `no_effect`); halted, skipped and unreached steps are dropped.
 * - Every fill/select value and upload file becomes `{{param}}`, named from the target (`title`, `title_2`, ...).
 *   No literal value is ever kept; `expect` text that contains a typed value is dropped; `goto` loses its query and fragment.
 * - Targets are written from `StepResult.resolved` as `{text, role, within?}`, never as `@ref`.
 * - `secrets` holds `"<batch>.<step>"` (zero-based positions in `sent`) of fields that were password / cc-* / one-time-code.
 */
export function buildPlan(intent: string, url: string, sent: Step[][], results: BatchResult[], secrets: Set<string>): Plan {
  const params: PlanParam[] = []
  const used = new Set<string>()
  const newParam = (targetText: string, secret: boolean): string => {
    const base = paramName(targetText)
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`
    used.add(name)
    params.push({ name, secret })
    return name
  }

  const values: string[] = []
  const batches: Step[][] = []
  sent.forEach((steps, b) => {
    const kept: Step[] = []
    steps.forEach((step, i) => {
      const r = results[b]?.steps[i]
      if (!r || !RAN_OK.has(r.status)) return
      const out: Record<string, unknown> = { ...step }
      if ("target" in step) {
        const resolved = r.resolved
        const t = step.target
        if (resolved) {
          const target: Record<string, string> = { text: resolved.name, role: resolved.role }
          if (resolved.within) target.within = resolved.within
          out.target = target
        } else if (typeof t === "object" && "text" in t) {
          out.target = t
        } else {
          throw new Error(`batch ${b} step ${i}: cannot store a ref target without a resolved name`)
        }
        delete out.within
        delete out.role
        const label = (out.target as { text: string }).text
        if (step.action === "fill" || step.action === "select") {
          values.push(step.value)
          out.value = `{{${newParam(label, secrets.has(`${b}.${i}`))}}}`
        } else if (step.action === "upload") {
          out.files = [`{{${newParam(label, secrets.has(`${b}.${i}`))}}}`]
        }
      }
      if (step.action === "goto") out.url = step.url.split(/[?#]/)[0]
      kept.push(out as unknown as Step)
    })
    batches.push(kept)
  })

  // an expectation that echoes a typed value would store that value
  const echoes = (text: string): boolean => values.some((v) => v && text.includes(v))
  for (const steps of batches) {
    for (const s of steps) {
      if (s.expect && echoes("text" in s.expect ? s.expect.text : s.expect.url)) delete s.expect
    }
  }

  let origin = url
  try {
    origin = new URL(url).origin
  } catch {
    /* keep the raw text */
  }
  return {
    version: 1,
    intent,
    origin,
    pathPattern: pathPattern(url),
    params,
    batches: batches.filter((b) => b.length),
    createdAt: new Date().toISOString(),
    runs: 0,
    lastOk: null,
  }
}

/** The plan's batches with every `{{param}}` replaced by `values[param]`. Throws `missing parameter: <name>`. */
export function fillPlan(plan: Plan, values: Record<string, string>): Step[][] {
  for (const p of plan.params) {
    if (!Object.hasOwn(values, p.name)) throw new Error(`missing parameter: ${p.name}`)
  }
  const sub = (s: string): string =>
    s.replace(PLACEHOLDER, (_, name: string) => {
      if (!Object.hasOwn(values, name)) throw new Error(`missing parameter: ${name}`)
      return values[name]!
    })
  return plan.batches.map((steps) =>
    steps.map((s) => {
      const c = { ...s } as Record<string, unknown>
      if (typeof c.value === "string") c.value = sub(c.value)
      if (Array.isArray(c.files)) c.files = (c.files as string[]).map(sub)
      return c as unknown as Step
    }),
  )
}
