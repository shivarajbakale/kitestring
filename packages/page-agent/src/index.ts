import { RefRegistry } from "./refs.js"
import { find, type FindIntent, type FindResult } from "./find.js"
import type { Target } from "@bx/protocol"
import { snapshot, type SnapshotOpts } from "./snapshot.js"

export interface PageAgent {
  snapshot(opts?: SnapshotOpts): string
  resolve(ref: string): Element | null
  find(target: Target, intent: FindIntent): FindResult
}

export function createAgent(win: Window): PageAgent {
  const doc = win.document
  const reg = new RefRegistry(doc)
  return {
    snapshot: (opts = {}) => snapshot(doc, reg, opts),
    resolve: (ref) => reg.resolve(ref),
    find: (target, intent) => find(doc, reg, target, intent)
  }
}

export { RefRegistry } from "./refs.js"
export { norm } from "./normalize.js"
export type { SnapshotOpts } from "./snapshot.js"
export { find } from "./find.js"
export type { FindResult, FindIntent } from "./find.js"
