import type { Candidate, Locator, Target } from "@kitestring/protocol"
import { describeLocator, resolveLocator } from "./locator.js"
import { norm } from "./normalize.js"
import type { RefRegistry } from "./refs.js"
import { INTERACTIVE_ROLES, LANDMARK_ROLES, nameOf, roleOf } from "./roles.js"
import { elementLine } from "./snapshot.js"

export type FindIntent = "click" | "fill" | "select"
export type FindResult =
  /**
   * `role`/`name`: the resolved element; `within`: the name of its nearest named scope (for text targets that re-find it);
   * `locator`: where a text target was found, for the action cache (absent for ref targets and secret fields);
   * `hinted`: the caller's hint pointed at the element the normal search ranked as the unique best match;
   * `secret`: a password / card / one-time-code field, which must not be cached.
   */
  | { kind: "found"; ref: string; line: string; role: string; name: string; within?: string; hinted: boolean; locator?: Locator; secret?: true }
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

function isSecretField(el: Element): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return false
  if (el instanceof HTMLInputElement && el.type === "password") return true
  return (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).some((t) => t === "one-time-code" || t.startsWith("cc-"))
}

export function find(doc: Document, reg: RefRegistry, target: Target, intent: FindIntent, hint?: Locator): FindResult {
  const ref = (target as { ref?: string }).ref
  if (typeof ref === "string") {
    const el = reg.resolve(ref)
    if (!el) return { kind: "not_found" }
    return found(el, ref, reg)
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
  // A hint never bypasses the search: it only counts when the search itself picked that element.
  let wasHinted = false
  if (hint) {
    const he = resolveLocator(doc, reg, hint)
    wasHinted = he === a.el && roleOf(a.el) === hint.role
  }
  return found(a.el, reg.refFor(a.el), reg, wasHinted, true)
}

function found(el: Element, ref: string, reg: RefRegistry, wasHinted = false, text = false): FindResult {
  const role = roleOf(el) ?? "generic"
  const res: Extract<FindResult, { kind: "found" }> = {
    kind: "found",
    ref,
    line: elementLine(el, role, reg),
    role,
    name: nameOf(el),
    hinted: wasHinted,
  }
  if (isSecretField(el)) res.secret = true
  else if (text) res.locator = describeLocator(el, reg)
  const within = scopeName(el)
  if (within) res.within = within
  return res
}

/** Name of the nearest enclosing scope `within` can match: its accessible name, else its own heading. */
function scopeName(el: Element): string | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (!isScope(p)) continue
    const name = nameOf(p) || (ownHeading(p)?.textContent ?? "").replace(/\s+/g, " ").trim()
    if (name) return name
  }
  return undefined
}

function lineFor(el: Element, reg: RefRegistry): string {
  return elementLine(el, roleOf(el) ?? "generic", reg)
}
