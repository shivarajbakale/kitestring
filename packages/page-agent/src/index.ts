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
import { pressTarget } from "./submit.js"
import { elementLine } from "./snapshot.js"
import { roleOf } from "./roles.js"
import { extract, type ExtractOpts, type ExtractResult } from "./extract.js"
import { ClickReceipts, type ArmResult, type Receipt } from "./receipt.js"
import { waitFor, type WaitCondition, type WaitResult } from "./wait.js"

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
  /** The page's visible text, at most `max` characters (a watch compares it run to run). */
  text(max: number): string
  /** Rows of the page's best (or chosen) table or repeated list (browser_extract). */
  extract(opts?: ExtractOpts): ExtractResult
  /** The last check before a click (attached, still, not covered), and start listening for what the click does. */
  armClick(ref: string): Promise<ArmResult>
  /** Whether the armed element received the press, and DOM changes since arming; null when nothing is armed. */
  clickReceipt(disarm: boolean): Receipt | null
  /** Resolves as soon as `cond` holds in this document, or after `ms` with what was last seen. */
  waitFor(cond: WaitCondition, ms: number): Promise<WaitResult>
  readValue(ref: string): string | null
  /** Picks the option whose value or visible text is `value`; its visible text, or null if there is none. */
  setSelect(ref: string, value: string): string | null
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
   * What a press of `key` (Enter or Space) on the focused element would activate, for the batch risk check: the focused
   * button or link itself, else (Enter in a form field) the form's default button, else the form (`ref` ""). null when it
   * activates nothing to check (no form, a textarea or contenteditable, Space off a button).
   */
  pressTarget(key: string): { ref: string; line: string; role: string; name: string } | null
}

const fold = (s: string): string => s.replace(/\s+/g, " ").toLowerCase()

export function createAgent(win: Window): PageAgent {
  const doc = win.document
  const reg = new RefRegistry(doc)
  const receipts = new ClickReceipts(win)
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
    text: (max) => (doc.body?.innerText ?? "").slice(0, max),
    extract: (opts) => extract(doc, opts),
    armClick: (ref) => receipts.arm(reg.resolve(ref)),
    clickReceipt: (disarm) => receipts.receipt(disarm),
    waitFor: (cond, ms) => waitFor(doc, reg, cond, ms),
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
      if (!(el instanceof HTMLSelectElement)) return null
      const want = norm(value)
      const opt = Array.from(el.options).find((o) => !o.disabled && o.value === value) ??
        Array.from(el.options).find((o) => !o.disabled && (norm(o.label) === want || norm(o.value) === want))
      if (!opt) return null
      opt.selected = true
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
      return opt.label || opt.text
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
    pressTarget: (key) => {
      const t = pressTarget(doc, key)
      if (!t) return null
      if (!t.control) return { ref: "", line: `form ${JSON.stringify(t.name)}`, role: "form", name: t.name }
      const role = roleOf(t.control) ?? "button"
      let ref = ""
      try {
        ref = reg.refFor(t.control)
      } catch {
        /* not in the snapshot's interactive set: the name is what is checked */
      }
      return { ref, line: ref ? elementLine(t.control, role, reg) : `${role} ${JSON.stringify(t.name)}`, role, name: t.name }
    },
  }
}

export { RefRegistry } from "./refs.js"
export { norm } from "./normalize.js"
export type { SnapshotOpts } from "./snapshot.js"
export type { ExtractOpts, ExtractResult, ExtractCandidate } from "./extract.js"
export type { ArmResult, Receipt } from "./receipt.js"
export type { WaitCondition, WaitResult } from "./wait.js"
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
