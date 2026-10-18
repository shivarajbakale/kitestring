import type { PlanParam, PlanStep } from "./plan.js"

/** What `record.stop` returns: the human's steps, already parameterized in the page (no values), and the secret param names. */
export interface Recording {
  name: string
  /** The tab's URL when recording started (where the plan begins). */
  url: string
  /** Every fill/select value and upload file is a `{{param}}`; option clicks and echoed text are params too. */
  steps: PlanStep[]
  /** Names of params whose field was a password / cc-* / one-time-code. */
  secrets: string[]
}

/**
 * A typed value remembered across pages without its text: a 53-bit hash of the normalized value and its length.
 * Never made for a secret field. Lives in the extension's memory only (never on disk, never sent to the CLI).
 */
export interface RecordEcho {
  h: number
  n: number
  param: string
}

/** What the background hands the recorder of a newly loaded page in the recorded tab. */
export interface RecorderState {
  /** Param names already allocated (new ones are deduped with `_2`, `_3`...). */
  used: string[]
  echoes: RecordEcho[]
}

/** One recorded human action, sent from the page to the background. */
export interface RecordedEvent {
  step: PlanStep
  /** Params this step allocated. */
  params: PlanParam[]
  /** Echoes of the non-secret values this step typed (for later pages). */
  echoes: RecordEcho[]
}

/** A recording's name: a lowercase slug of at most 48 characters (skill `kite-<name>`, plan `<name>`). */
export const RECORD_NAME_RE = /^(?=.{1,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Values shorter than this are not matched inside other text (as in `buildPlan`). */
export const MIN_ECHO = 3
/** Text longer than this is only searched in its first part. */
const ECHO_SCAN_MAX = 300

/** Case-folded, whitespace collapsed: the comparison form of a value or a name. */
export const normEcho = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim()

/** cyrb53: a fast 53-bit string hash. */
function hash53(s: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** The echo of `value` for `param`, or undefined when the value is too short to match. */
export function echoEntry(value: string, param: string): RecordEcho | undefined {
  const v = normEcho(value)
  return v.length >= MIN_ECHO ? { h: hash53(v), n: v.length, param } : undefined
}

/** The longest echo whose value occurs in `text` (normalized), else undefined. */
export function findEcho(text: string, echoes: readonly RecordEcho[]): RecordEcho | undefined {
  if (!echoes.length) return undefined
  const t = normEcho(text).slice(0, ECHO_SCAN_MAX)
  const byLen = new Map<number, RecordEcho[]>()
  for (const e of echoes) if (e.n <= t.length) byLen.set(e.n, [...(byLen.get(e.n) ?? []), e])
  for (const n of [...byLen.keys()].sort((a, b) => b - a)) {
    const group = byLen.get(n)!
    for (let i = 0; i + n <= t.length; i++) {
      const h = hash53(t.slice(i, i + n))
      const e = group.find((g) => g.h === h)
      if (e) return e
    }
  }
  return undefined
}
