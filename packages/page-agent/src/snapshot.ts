import { RefRegistry } from "./refs.js"
import { INTERACTIVE_ROLES, LANDMARK_ROLES, nameOf, roleOf } from "./roles.js"

export interface SnapshotOpts {
  full?: boolean
  scope?: string
  maxLines?: number
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"])
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"])
const CHECK_ROLES = new Set(["checkbox", "radio", "switch"])
const COLLAPSE_OVER = 5
const SHOWN_ITEMS = 3

function q(s: string): string {
  const t = s.replace(/\s+/g, " ").trim()
  return `"${(t.length > 100 ? t.slice(0, 99) + "…" : t).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function valueOf(el: Element): string {
  if (el instanceof HTMLSelectElement) {
    return Array.from(el.selectedOptions).map((o) => o.text.trim()).join(", ")
  }
  if (el instanceof HTMLInputElement && el.type === "password") return el.value ? "••••" : ""
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
  return el.getAttribute("aria-valuenow") ?? el.getAttribute("aria-valuetext") ?? el.textContent?.trim() ?? ""
}

function annotations(el: Element, role: string): string {
  let out = ""
  if (VALUE_ROLES.has(role)) out += ` value=${q(valueOf(el))}`
  if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") out += " disabled"
  if (CHECK_ROLES.has(role)) {
    const checked = el instanceof HTMLInputElement ? el.checked : el.getAttribute("aria-checked") === "true"
    if (checked) out += " checked"
  }
  if (el.getAttribute("aria-expanded") === "true") out += " expanded"
  return out
}

/** Snapshot line (no indentation) for an interactive element. */
export function elementLine(el: Element, role: string, reg: RefRegistry): string {
  const name = nameOf(el)
  return `${role}${name ? " " + q(name) : ""} [${reg.refFor(el)}]${annotations(el, role)}`
}

export function snapshot(doc: Document, reg: RefRegistry, opts: SnapshotOpts = {}): string {
  const win = doc.defaultView!
  const lines: string[] = [`page ${q(doc.title)} ${doc.location.href}`]
  reg.rescan()

  const full = !!opts.full || !!opts.scope

  const pruned = (el: Element): boolean => {
    if (SKIP_TAGS.has(el.tagName) || el.getAttribute("aria-hidden") === "true") return true
    const cs = win.getComputedStyle(el)
    return cs.display === "none"
  }

  /** Emittable: not visibility-hidden, non-zero size, and (unless full) intersecting the viewport. */
  const shown = (el: Element): boolean => {
    if (win.getComputedStyle(el).visibility !== "visible") return false
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    if (full) return true
    return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth
  }

  const children = (el: Element, depth: number): void => {
    for (const c of Array.from(el.children)) walk(c, depth)
  }

  const line = (depth: number, text: string): void => {
    lines.push("  ".repeat(depth) + text)
  }

  const walk = (el: Element, depth: number): void => {
    if (pruned(el)) return
    const role = roleOf(el)
    if (role && INTERACTIVE_ROLES.has(role)) {
      const visible = shown(el)
      if (visible) {
        line(depth, elementLine(el, role, reg))
      }
      if (role === "listbox" && !(el instanceof HTMLSelectElement)) children(el, visible ? depth + 1 : depth)
      return
    }
    if (role === "heading") {
      if (shown(el)) {
        const name = nameOf(el)
        line(depth, `heading${name ? " " + q(name) : ""}`)
        children(el, depth + 1)
      } else children(el, depth)
      return
    }
    if (role === "list") {
      const items = Array.from(el.children).filter((c) => !pruned(c) && roleOf(c) === "listitem")
      const name = nameOf(el)
      const visible = shown(el)
      if (items.length > COLLAPSE_OVER) {
        if (visible) {
          line(depth, `list${name ? " " + q(name) : ""} (${items.length} items) item[0..${SHOWN_ITEMS - 1}] … +${items.length - SHOWN_ITEMS}`)
        }
        for (const it of items.slice(0, SHOWN_ITEMS)) children(it, visible ? depth + 1 : depth)
        return
      }
      if (name && visible) {
        line(depth, `list ${q(name)}`)
        children(el, depth + 1)
      } else children(el, depth)
      return
    }
    if (role && LANDMARK_ROLES.has(role)) {
      const visible = shown(el)
      if (visible) {
        const name = nameOf(el)
        line(depth, `${role}${name ? " " + q(name) : ""}`)
      }
      children(el, visible ? depth + 1 : depth)
      return
    }
    children(el, depth)
  }

  let root: Element | null = doc.body
  if (opts.scope) {
    root = reg.resolve(opts.scope)
    if (!root) {
      lines.push(`(scope ${opts.scope} not found)`)
      return lines.join("\n")
    }
  }
  if (root) walk(root, 0)

  if (opts.maxLines !== undefined && lines.length > opts.maxLines) {
    const extra = lines.length - opts.maxLines
    lines.length = opts.maxLines
    lines.push(`… +${extra} more lines`)
  }
  return lines.join("\n")
}
