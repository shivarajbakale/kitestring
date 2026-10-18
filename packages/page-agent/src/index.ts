import { RefRegistry } from "./refs.js"
import { find, type FindIntent, type FindResult } from "./find.js"
import type { Target } from "@kitestring/protocol"
import { snapshot, type SnapshotOpts } from "./snapshot.js"
import { check, type CheckResult } from "./check.js"
import { waitQuiet } from "./quiet.js"
import { brief } from "./brief.js"
import { norm } from "./normalize.js"
import { closerFor, type Closer } from "./popups.js"
import { fileInputFor, fileNames } from "./files.js"

export interface PageAgent {
  snapshot(opts?: SnapshotOpts): string
  resolve(ref: string): Element | null
  find(target: Target, intent: FindIntent): FindResult
  check(ref: string): CheckResult
  /** For a target covered by a cookie wall or newsletter modal: the control that dismisses it, else null. */
  closerFor(ref: string): Closer | null
  /** Scrolls the element into view; its box in document (page) coordinates, or null if absent/empty. */
  rect(ref: string): { x: number; y: number; width: number; height: number } | null
  waitQuiet(): Promise<{ quiet: boolean; waitedMs: number }>
  brief(): string
  readValue(ref: string): string | null
  setSelect(ref: string, value: string): boolean
  /** The file input a click on this element feeds (see files.ts), else null. */
  fileInputFor(ref: string): { ref: string; multiple: boolean } | null
  /** Names of the files selected in this file input; null if the ref is not a file input. */
  fileNames(ref: string): string[] | null
  /** Tags the element with `data-kite-upload=<token>` so the main world can find it (CDP upload). */
  markFileInput(ref: string, token: string): boolean
  unmarkFileInput(token: string): void
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
    closerFor: (ref) => closerFor(doc, reg, reg.resolve(ref)),
    rect: (ref) => {
      const el = reg.resolve(ref)
      if (!el || !el.isConnected) return null
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return null
      return { x: r.left + win.scrollX, y: r.top + win.scrollY, width: r.width, height: r.height }
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
    },
    fileInputFor: (ref) => {
      const el = reg.resolve(ref)
      const input = el && fileInputFor(el)
      return input ? { ref: reg.refFor(input), multiple: input.multiple } : null
    },
    fileNames: (ref) => fileNames(reg.resolve(ref)),
    markFileInput: (ref, token) => {
      const el = reg.resolve(ref)
      if (!el) return false
      el.setAttribute("data-kite-upload", token)
      return true
    },
    unmarkFileInput: (token) => {
      for (const el of Array.from(doc.querySelectorAll("[data-kite-upload]"))) {
        if (el.getAttribute("data-kite-upload") === token) el.removeAttribute("data-kite-upload")
      }
    },
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
export { closerFor } from "./popups.js"
export { fileInputFor, fileNames } from "./files.js"
export type { Closer } from "./popups.js"
