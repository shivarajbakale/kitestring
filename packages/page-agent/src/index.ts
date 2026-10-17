import { RefRegistry } from "./refs.js"
import { snapshot, type SnapshotOpts } from "./snapshot.js"

export interface PageAgent {
  snapshot(opts?: SnapshotOpts): string
  resolve(ref: string): Element | null
}

export function createAgent(win: Window): PageAgent {
  const doc = win.document
  const reg = new RefRegistry(doc)
  return {
    snapshot: (opts = {}) => snapshot(doc, reg, opts),
    resolve: (ref) => reg.resolve(ref)
  }
}

export { RefRegistry } from "./refs.js"
export { norm } from "./normalize.js"
export type { SnapshotOpts } from "./snapshot.js"
