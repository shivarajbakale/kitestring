import type { Candidate, Target } from "@bx/protocol"
import { norm } from "./normalize.js"
import type { RefRegistry } from "./refs.js"
import { INTERACTIVE_ROLES, LANDMARK_ROLES, nameOf, roleOf } from "./roles.js"
import { elementLine } from "./snapshot.js"

export type FindIntent = "click" | "fill" | "select"
export type FindResult =
  | { kind: "found"; ref: string; line: string }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "not_found" }

const FILL_ROLES = new Set(["textbox", "searchbox", "combobox"])
const SELECT_ROLES = new Set(["combobox", "listbox"])
const SCOPE_ROLES = new Set(["section", "region", "form", "fieldset", "dialog", "alertdialog"])
const SCOPE_TAGS = new Set(["SECTION", "FORM", "FIELDSET", "DIALOG"])

function intentOk(el: Element, role: string, intent: FindIntent): boolean {
  if (intent === "fill") return FILL_ROLES.has(role) || (el instanceof HTMLElement && el.isContentEditable)
  if (intent === "select") return SELECT_ROLES.has(role)
  return INTERACTIVE_ROLES.has(role)
}

function tokens(s: string): string[] {
  return s.split(" ").filter(Boolean)
}

/** Score `source` against normalized `target`; exact tier value depends on the source. */
function scoreText(target: string, source: string, exact: number): number {
  const s = norm(source)
  if (!s) return 0
  if (s === target) return exact
  if (s.startsWith(target)) return 70
  if (s.includes(target)) return 50
  const tt = tokens(target)
  const st = new Set(tokens(s))
  if (tt.length && tt.filter((t) => st.has(t)).length / tt.length >= 0.6) return 30
  return 0
}

function labelTexts(el: Element): string[] {
  const out: string[] = []
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    for (const l of Array.from(el.labels ?? [])) out.push(l.textContent ?? "")
  }
  const by = el.getAttribute("aria-labelledby")
  if (by) {
    for (const id of by.split(/\s+/)) {
      const n = el.ownerDocument.getElementById(id)
      if (n) out.push(n.textContent ?? "")
    }
  }
  return out
}

function scoreElement(el: Element, target: string): number {
  let best = scoreText(target, nameOf(el), 100)
  const consider = (v: string | null | undefined, exact: number): void => {
    if (v) best = Math.max(best, scoreText(target, v, exact))
  }
  for (const l of labelTexts(el)) consider(l, 95)
  consider(el.getAttribute("aria-label"), 95)
  consider(el.getAttribute("title"), 95)
  consider(el.getAttribute("placeholder"), 90)
  return best
}

function visibleAndInView(el: Element): { visible: boolean; inView: boolean } {
  const win = el.ownerDocument.defaultView!
  const cs = win.getComputedStyle(el)
  const r = el.getBoundingClientRect()
  const visible = cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0
  const inView = visible && r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth
  return { visible, inView }
}

function isScope(el: Element): boolean {
  const role = roleOf(el)
  return (!!role && role !== "heading" && role !== "list" && (LANDMARK_ROLES.has(role) || SCOPE_ROLES.has(role))) || SCOPE_TAGS.has(el.tagName)
}

/** First heading belonging to this scope (not inside a nested scope). */
function ownHeading(el: Element): Element | null {
  for (const h of Array.from(el.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]"))) {
    let p = h.parentElement
    while (p && p !== el && !isScope(p)) p = p.parentElement
    if (p === el) return h
  }
  return null
}

function scopeMatches(el: Element, within: string): boolean {
  if (norm(nameOf(el)) === within) return true
  const h = ownHeading(el)
  return !!h && norm(h.textContent ?? "") === within
}

export function find(doc: Document, reg: RefRegistry, target: Target, intent: FindIntent): FindResult {
  const ref = (target as { ref?: string }).ref
  if (typeof ref === "string") {
    const el = reg.resolve(ref)
    if (!el) return { kind: "not_found" }
    return { kind: "found", ref, line: lineFor(el, reg) }
  }
  const t = target as { text: string; within?: string; role?: string }
  const text = norm(t.text)
  if (!text) return { kind: "not_found" }
  reg.rescan()

  let scopes: Element[] | null = null
  if (t.within !== undefined) {
    const w = norm(t.within)
    const matching = Array.from(doc.querySelectorAll("*")).filter((e) => isScope(e) && scopeMatches(e, w))
    scopes = matching.filter((e) => !matching.some((o) => o !== e && e.contains(o)))
    if (!scopes.length) return { kind: "not_found" }
  }

  const scored: { el: Element; score: number }[] = []
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const role = roleOf(el)
    if (!role || !INTERACTIVE_ROLES.has(role)) continue
    if (t.role && role !== t.role) continue
    if (!intentOk(el, role, intent)) continue
    if (scopes && !scopes.some((s) => s !== el && s.contains(el))) continue
    let score = scoreElement(el, text)
    if (score <= 0) continue
    const v = visibleAndInView(el)
    if (v.visible) score += 5
    if (v.inView) score += 3
    scored.push({ el, score })
  }
  if (!scored.length) return { kind: "not_found" }
  scored.sort((a, b) => b.score - a.score)

  const [a, b] = scored
  if (b && a.score - b.score <= 5 && a.score >= 50 && b.score >= 50) {
    const top = a.score
    const group = scored.filter((c) => top - c.score <= 5 && c.score >= 50).slice(0, 3)
    return {
      kind: "ambiguous",
      candidates: group.map((c) => ({ ref: reg.refFor(c.el), line: lineFor(c.el, reg), score: c.score }))
    }
  }
  return { kind: "found", ref: reg.refFor(a.el), line: lineFor(a.el, reg) }
}

function lineFor(el: Element, reg: RefRegistry): string {
  return elementLine(el, roleOf(el) ?? "generic", reg)
}
