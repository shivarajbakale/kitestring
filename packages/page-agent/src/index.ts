import { RefRegistry } from "./refs.js"
import { find, type FindIntent, type FindResult } from "./find.js"
import type { Locator, Target } from "@kitestring/protocol"
import { snapshot, type SnapshotOpts } from "./snapshot.js"
import { check, type CheckResult } from "./check.js"
import { waitQuiet } from "./quiet.js"
import { brief } from "./brief.js"
import { norm } from "./normalize.js"
import { closerFor, type Closer } from "./popups.js"
import { fileInputFor, fileNames, watchFileInput } from "./files.js"
import { enterSubmit } from "./submit.js"
import { elementLine } from "./snapshot.js"
import { roleOf } from "./roles.js"

export interface PageAgent {
  snapshot(opts?: SnapshotOpts): string
  resolve(ref: string): Element | null
  find(target: Target, intent: FindIntent, hint?: Locator): FindResult
  check(ref: string): CheckResult
  /** For a target covered by a cookie wall or newsletter modal: the control that dismisses it, else null. */
  closerFor(ref: string): Closer | null
  /** Scrolls the element into view; its box in document (page) coordinates, or null if absent/empty. */
  rect(ref: string): { x: number; y: number; width: number; height: number } | null
  waitQuiet(): Promise<{ quiet: boolean; waitedMs: number }>
  brief(): string
  /** Case-folded substring test against the page's visible text (batch `expect: {text}`). */
  hasText(text: string): boolean
  readValue(ref: string): string | null
  setSelect(ref: string, value: string): boolean
  /** The file input a click on this element feeds (see files.ts), else null. */
  fileInputFor(ref: string): { ref: string; multiple: boolean } | null
  /** Names of the files selected in this file input (as recorded at dispatch if watched); null if not a file input. */
  fileNames(ref: string): string[] | null
  /** Records the input's file names when it next dispatches input/change (see files.ts); false if not a file input. */
  watchFileInput(ref: string): boolean
  /** Tags the element with `data-kite-upload=<token>` so the main world can find it (CDP upload). */
  markFileInput(ref: string, token: string): boolean
  unmarkFileInput(token: string): void
  /**
   * What an Enter on the focused element would submit (its form's default button, else the form),
   * for the batch risk check (`ref` is "" for a form without a submit button); null when focus is not inside a form.
   */
  enterSubmit(): { ref: string; line: string; role: string; name: string } | null
}

const fold = (s: string): string => s.replace(/\s+/g, " ").toLowerCase()

export function createAgent(win: Window): PageAgent {
  const doc = win.document
  const reg = new RefRegistry(doc)
  return {
    snapshot: (opts = {}) => snapshot(doc, reg, opts),
    resolve: (ref) => reg.resolve(ref),
    find: (target, intent, hint) => find(doc, reg, target, intent, hint),
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
    hasText: (text) => fold(doc.body?.innerText ?? "").includes(fold(text)),
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
    watchFileInput: (ref) => watchFileInput(reg.resolve(ref)),
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
    enterSubmit: () => {
      const s = enterSubmit(doc)
      if (!s) return null
      if (!s.button) return { ref: "", line: `form ${JSON.stringify(s.name)}`, role: "form", name: s.name }
      const role = roleOf(s.button) ?? "button"
      return { ref: reg.refFor(s.button), line: elementLine(s.button, role, reg), role, name: s.name }
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
export { fileInputFor, fileNames, watchFileInput } from "./files.js"
export type { Closer } from "./popups.js"
export { describeLocator, resolveLocator } from "./locator.js"
export { startRecorder } from "./recorder.js"
export type { Recorder } from "./recorder.js"
