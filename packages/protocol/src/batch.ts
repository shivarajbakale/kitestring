import { z } from "zod"
import { parseTarget, type Target } from "./target.js"
import type { ActionResult, Candidate, Diff, Status } from "./results.js"

export const BATCH_MAX_STEPS = 50
export const BATCH_BUDGET_DEFAULT_MS = 40_000
export const BATCH_BUDGET_MIN_MS = 5_000
/** A step does not start with less budget than this left. */
export const BATCH_STEP_MIN_START_MS = 3_000
export const STEP_WAIT_MAX_MS = 10_000
export const BATCH_RESULT_MAX_BYTES = 900_000
export const BATCH_DIFF_MAX_LINES = 40

/** text: substring of page text; url: substring or /regex/. */
export type Expect = { text: string } | { url: string }

export interface StepBase {
  /** ms to wait for the target to appear (polls find), max 10_000. */
  wait?: number
  /** Checked after the step settles. */
  expect?: Expect
  /** Target missing: step is "skipped" and the batch continues. */
  if_present?: boolean
  within?: string
  role?: string
  /** Policy for a dialog this step triggers (overrides the guard default). */
  dialog?: "accept" | "dismiss"
  /** Internal (set by plan replay): the target text came from a plan param, so the action cache must not keep it. */
  nocache?: boolean
}

export type Step = StepBase &
  (
    | { action: "goto"; url: string }
    | { action: "click"; target: string | Target }
    | { action: "fill"; target: string | Target; value: string }
    | { action: "select"; target: string | Target; value: string }
    | { action: "press"; key: string }
    | { action: "scroll"; direction: "up" | "down"; px?: number }
    | { action: "upload"; target: string | Target; files: string[] }
    | { action: "switch_tab"; to: "new" | "opener" | number }
    | { action: "wait"; ms?: number; expect?: Expect }
  )

export interface BatchParams {
  /** 1..50 */
  steps: Step[]
  /** Extra registrable domains the domain guard accepts. */
  allow_domains?: string[]
  /** Default: the session's active tab. */
  tab?: number
  /** Default 40_000, clamped to 5_000..40_000 (see clampBudget). */
  budget_ms?: number
}

export type HaltReason =
  | "not_found"
  | "ambiguous"
  | "blocked"
  | "disabled"
  | "error"
  | "timeout"
  | "restricted"
  | "domain"
  | "dialog"
  | "expect"
  | "risky"
  | "paused"
  | "time"

export interface StepResult {
  i: number
  action: string
  target?: string
  status: Status | "skipped"
  detail?: string
  ms: number
  /** The element FIND matched is where the action cache last found it (the full search still ran). */
  cached?: boolean
  /** Internal: the pipeline's resolved target, used to write stored plans (refs are never stored). */
  resolved?: { role: string; name: string; within?: string }
  /** Internal: the resolved field was a password / cc-* / one-time-code input (its value becomes a secret plan param). */
  secret?: true
  /** Internal: a select's chosen option text, which stored plans treat as a value (never stored). */
  chosen?: string
}

export interface BatchResult {
  /** True iff every step ran (done / no_effect / skipped). */
  ok: boolean
  steps: StepResult[]
  halted?: { index: number; reason: HaltReason; detail?: string }
  /** First step not run, when halted. */
  next?: number
  diff: Diff
  navigation?: ActionResult["navigation"]
  newTabs?: number[]
  dialogs?: { type: string; message: string; handled: "accepted" | "dismissed" }[]
  closedPopups?: string[]
  candidates?: Candidate[]
  blockedBy?: string
  page: string
  /** Internal: the tab's URL when the batch began (where a stored plan starts). */
  startUrl?: string
}

export function clampBudget(ms?: number): number {
  if (ms === undefined || !Number.isFinite(ms)) return BATCH_BUDGET_DEFAULT_MS
  return Math.min(BATCH_BUDGET_DEFAULT_MS, Math.max(BATCH_BUDGET_MIN_MS, Math.round(ms)))
}

const TargetObj = z.union([
  z.object({ ref: z.string() }),
  z.object({ text: z.string(), within: z.string().optional(), role: z.string().optional() }),
])
const TargetIn = z.union([z.string().min(1, "must not be empty"), TargetObj], {
  errorMap: () => ({ message: "required: a string or {ref} / {text}" }),
})
const ExpectSchema = z.union([z.object({ text: z.string() }), z.object({ url: z.string() })], {
  errorMap: () => ({ message: "must be {text} or {url}" }),
})

const base = {
  wait: z.number().min(0).max(STEP_WAIT_MAX_MS, `at most ${STEP_WAIT_MAX_MS} ms`).optional(),
  expect: ExpectSchema.optional(),
  if_present: z.boolean().optional(),
  within: z.string().optional(),
  role: z.string().optional(),
  dialog: z.enum(["accept", "dismiss"]).optional(),
  nocache: z.boolean().optional(),
}
const req = (what: string) => ({ required_error: `required for ${what}` })

const StepSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("goto"), url: z.string(req("goto")).min(1) }),
  z.object({ ...base, action: z.literal("click"), target: TargetIn }),
  z.object({ ...base, action: z.literal("fill"), target: TargetIn, value: z.string(req("fill")) }),
  z.object({ ...base, action: z.literal("select"), target: TargetIn, value: z.string(req("select")) }),
  z.object({ ...base, action: z.literal("press"), key: z.string(req("press")).min(1) }),
  z.object({
    ...base,
    action: z.literal("scroll"),
    direction: z.enum(["up", "down"], req("scroll")),
    px: z.number().positive().optional(),
  }),
  z.object({
    ...base,
    action: z.literal("upload"),
    target: TargetIn,
    files: z.array(z.string().min(1), req("upload")).min(1, "at least one file required"),
  }),
  z.object({
    ...base,
    action: z.literal("switch_tab"),
    to: z.union([z.literal("new"), z.literal("opener"), z.number().int()], req("switch_tab")),
  }),
  z.object({
    ...base,
    action: z.literal("wait"),
    ms: z.number().min(0).max(STEP_WAIT_MAX_MS, `at most ${STEP_WAIT_MAX_MS} ms`).optional(),
  }),
])

const BatchSchema = z.object({
  steps: z
    .array(StepSchema, { required_error: "required" })
    .min(1, "at least 1 step required")
    .max(BATCH_MAX_STEPS, `at most ${BATCH_MAX_STEPS} steps`),
  allow_domains: z.array(z.string()).optional(),
  tab: z.number().int().optional(),
  budget_ms: z.number().optional(),
})

function formatPath(path: (string | number)[]): string {
  return path.reduce<string>((s, p) => (typeof p === "number" ? `${s}[${p}]` : s ? `${s}.${p}` : p), "")
}

/** Validates raw batch params. String targets become Target objects (folding the step's `within`/`role`). */
export function parseBatchParams(raw: unknown): BatchParams {
  const r = BatchSchema.safeParse(raw)
  if (!r.success) {
    const i = r.error.issues[0]!
    const p = formatPath(i.path)
    throw new Error(p ? `${p}: ${i.message}` : i.message)
  }
  const steps = r.data.steps.map((s) => {
    if ("target" in s && typeof s.target === "string") {
      return { ...s, target: parseTarget(s.target, { within: s.within, role: s.role }) }
    }
    return s
  })
  return { ...r.data, steps } as BatchParams
}
