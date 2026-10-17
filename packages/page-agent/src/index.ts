import { RefRegistry } from "./refs.js"
import { find, type FindIntent, type FindResult } from "./find.js"
import type { Target } from "@bx/protocol"
import { snapshot, type SnapshotOpts } from "./snapshot.js"
import { check, type CheckResult } from "./check.js"
import { waitQuiet } from "./quiet.js"
import { brief } from "./brief.js"
import { norm } from "./normalize.js"

export interface PageAgent {
  snapshot(opts?: SnapshotOpts): string
  resolve(ref: string): Element | null
  find(target: Target, intent: FindIntent): FindResult
  check(ref: string): CheckResult
  waitQuiet(): Promise<{ quiet: boolean; waitedMs: number }>
  brief(): string
  readValue(ref: string): string | null
  setSelect(ref: string, value: string): boolean
}

export function createAgent(win: Window): PageAgent {
  const doc = win.document
  const reg = new RefRegistry(doc)
  return {
    snapshot: (opts = {}) => snapshot(doc, reg, opts),
    resolve: (ref) => reg.resolve(ref),
    find: (target, intent) => find(doc, reg, target, intent),
    check: (ref) => {
      const el = reg.resolve(ref)
      return el ? check(el) : { kind: "hidden" }
    },
    waitQuiet: () => waitQuiet(win),
    brief: () => brief(doc),
    readValue: (ref) => {
      const el = reg.resolve(ref)
      if (!el) return null
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        return el.value
      }
      return el instanceof HTMLElement && el.isContentEditable ? el.textContent : null
    },
    setSelect: (ref, value) => {
      const el = reg.resolve(ref)
      if (!(el instanceof HTMLSelectElement)) return false
      const want = norm(value)
      const opt = Array.from(el.options).find((o) => !o.disabled && o.value === value) ??
        Array.from(el.options).find((o) => !o.disabled && (norm(o.label) === want || norm(o.value) === want))
      if (!opt) return false
      opt.selected = true
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
      return true
    }
  }
}

export { RefRegistry } from "./refs.js"
export { norm } from "./normalize.js"
export type { SnapshotOpts } from "./snapshot.js"
export { find } from "./find.js"
export type { FindResult, FindIntent } from "./find.js"
export { check } from "./check.js"
export type { CheckResult } from "./check.js"
export { waitQuiet } from "./quiet.js"
export { diffSnapshots } from "./diff.js"
export type { Diff } from "./diff.js"
export { brief } from "./brief.js"
