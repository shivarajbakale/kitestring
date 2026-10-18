import type { Step } from "./batch.js"

/** A stored step; `droppedQuery` marks a goto whose query / fragment was not stored (it may have mattered). */
export type PlanStep = Step & { droppedQuery?: boolean }

/** A stored, parameterized task: batches whose values and upload files are `{{param}}` placeholders. */
export interface Plan {
  version: 1
  intent: string
  origin: string
  pathPattern: string
  params: PlanParam[]
  batches: PlanStep[][]
  createdAt: string
  runs: number
  lastOk: string | null
}

export interface PlanParam {
  name: string
  /** The field was a password / cc-* / one-time-code: the agent must supply it every run. */
  secret: boolean
}

/** Lowercase kebab slug, safe as a file or directory name. `fallback` when nothing usable is left. */
export function slug(text: string, fallback = "plan"): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
  return s || fallback
}

/** The parameter name for a field: `slug(target text)` with underscores, e.g. "Store title" -> "store_title". */
export function paramName(target: string): string {
  return slug(target, "value").replace(/-/g, "_")
}
