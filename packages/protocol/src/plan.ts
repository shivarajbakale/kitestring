import type { Step, StepBase } from "./batch.js"
import type { Target } from "./target.js"

/**
 * Roles whose accessible name is a picked value (a contact, a suggestion, a date cell), not page structure: a click on
 * one is a plan param, its text is echo-checked like a typed value, and the action cache never keeps it.
 */
export const CHOICE_ROLES: ReadonlySet<string> = new Set(["option", "menuitemradio", "treeitem", "gridcell"])

/** A target with no name text, stored when the field's name echoed a value. */
export type RoleTarget = { role: string; within?: string }
export type PlanTarget = Target | RoleTarget

/**
 * A fill / select / upload whose field name echoed a value, or a click named after a select's chosen text that no param
 * replays, so only its role (and clean scope) was stored.
 * Replay rule: a replay halts at a role-only step and hands the page to the agent; it never guesses a field.
 */
export type RoleStep = StepBase &
  (
    | { action: "click"; target: RoleTarget }
    | { action: "fill" | "select"; target: RoleTarget; value: string }
    | { action: "upload"; target: RoleTarget; files: string[] }
  )

/** A step as stored and as filled for replay: a normal `Step`, or a role-only one (see {@link RoleStep}). */
export type ReplayStep = Step | RoleStep

/** A stored step; `droppedQuery` marks a goto whose query / fragment was not stored (it may have mattered). */
export type PlanStep = ReplayStep & { droppedQuery?: boolean }

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
