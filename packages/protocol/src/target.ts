import { REF_RE } from "./constants.js"

export type Target = { ref: string } | { text: string; within?: string; role?: string }

export function parseTarget(input: string, opts: { within?: string; role?: string } = {}): Target {
  if (REF_RE.test(input)) return { ref: input }
  const t: { text: string; within?: string; role?: string } = { text: input }
  if (opts.within !== undefined) t.within = opts.within
  if (opts.role !== undefined) t.role = opts.role
  return t
}
