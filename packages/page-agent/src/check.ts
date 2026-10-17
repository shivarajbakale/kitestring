import { nameOf, roleOf } from "./roles.js"

export type CheckResult =
  | { kind: "ok"; x: number; y: number }
  | { kind: "blocked"; by: string }
  | { kind: "disabled"; errors: string[] }
  | { kind: "hidden" }

const GENERIC = new Set(["generic", "presentation", "none"])
const DESCENDANT_ROLES = ["dialog", "alertdialog", "banner", "region", "complementary"]

function isVisible(win: Window, el: Element): boolean {
  const cs = win.getComputedStyle(el)
  if (cs.display === "none" || cs.visibility !== "visible") return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function describeRole(el: Element, role: string): string {
  const name = nameOf(el)
  return name ? `${role} "${name}"` : role
}

function describe(cover: Element): string {
  for (let e: Element | null = cover; e && e !== e.ownerDocument.body && e !== e.ownerDocument.documentElement; e = e.parentElement) {
    const role = roleOf(e)
    if (role && !GENERIC.has(role)) return describeRole(e, role)
  }
  for (const d of Array.from(cover.querySelectorAll("*"))) {
    const role = roleOf(d)
    if (role && DESCENDANT_ROLES.includes(role)) return describeRole(d, role)
  }
  return `<${cover.tagName.toLowerCase()}>${cover.id ? "#" + cover.id : ""}`
}

function pageErrors(el: Element, win: Window): string[] {
  const scope: ParentNode = el.closest("form") ?? win.document
  const doc = win.document
  const nodes: Element[] = Array.from(doc.querySelectorAll('[role="alert"], [aria-live]:not([aria-live="off"])'))
  for (const field of Array.from(scope.querySelectorAll('[aria-invalid="true"]'))) {
    for (const attr of ["aria-errormessage", "aria-describedby"]) {
      for (const id of (field.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean)) {
        const ref = doc.getElementById(id)
        if (ref) nodes.push(ref)
      }
    }
  }
  const out: string[] = []
  for (const n of nodes) {
    if (!isVisible(win, n)) continue
    const t = (n.textContent ?? "").replace(/\s+/g, " ").trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** Is el ready to receive a click at its centre? Scrolls it into view first. */
export function check(el: Element): CheckResult {
  const doc = el.ownerDocument
  const win = doc.defaultView!
  if (!el.isConnected) return { kind: "hidden" }
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
  const rect = el.getBoundingClientRect()
  const cs = win.getComputedStyle(el)
  if (rect.width <= 0 || rect.height <= 0 || cs.display === "none" || cs.visibility === "hidden") {
    return { kind: "hidden" }
  }
  if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") {
    return { kind: "disabled", errors: pageErrors(el, win) }
  }
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const top = doc.elementFromPoint(x, y)
  if (top && (top === el || el.contains(top))) return { kind: "ok", x, y }
  if (!top) return { kind: "hidden" }
  return { kind: "blocked", by: describe(top) }
}
