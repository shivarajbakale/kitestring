import type { Locator } from "@kitestring/protocol"
import { landmarkNames, type RefRegistry } from "./refs.js"
import { INTERACTIVE_ROLES, nameOf, roleOf } from "./roles.js"

function cssPathOf(el: Element): string {
  const doc = el.ownerDocument
  const parts: string[] = []
  for (let p: Element | null = el; p && p !== doc.documentElement; p = p.parentElement) {
    if (p.id) {
      const sel = `#${CSS.escape(p.id)}`
      if (doc.querySelectorAll(sel).length === 1) {
        parts.unshift(sel)
        return parts.join(" > ")
      }
    }
    const tag = p.tagName.toLowerCase()
    const same = p.parentElement ? Array.from(p.parentElement.children).filter((c) => c.tagName === p!.tagName) : [p]
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(p) + 1})` : tag)
  }
  return ["html", ...parts].join(" > ")
}

/** Interactive elements with this role, name and landmark path, in document order. */
function twins(doc: Document, role: string, name: string, path: string): Element[] {
  return Array.from(doc.querySelectorAll("*")).filter(
    (e) => roleOf(e) === role && INTERACTIVE_ROLES.has(role) && nameOf(e) === name && landmarkNames(e).join("/") === path,
  )
}

export function describeLocator(el: Element, reg: RefRegistry): Locator {
  const role = roleOf(el) ?? "generic"
  const name = nameOf(el)
  const landmarkPath = landmarkNames(el)
  const nth = Math.max(0, twins(el.ownerDocument, role, name, landmarkPath.join("/")).indexOf(el))
  return { ref: reg.refFor(el), role, name, landmarkPath, cssPath: cssPathOf(el), nth }
}

/**
 * The element a locator points at: its ref, else its CSS path, else the nth element with its role
 * and name inside its landmarks. A candidate only: the caller must still check role and name.
 */
export function resolveLocator(doc: Document, reg: RefRegistry, loc: Locator): Element | null {
  const byRef = reg.resolve(loc.ref)
  if (byRef) return byRef
  try {
    const byCss = doc.querySelector(loc.cssPath)
    if (byCss) return byCss
  } catch {
    // malformed path: fall through
  }
  const all = twins(doc, loc.role, loc.name, loc.landmarkPath.join("/"))
  return all[loc.nth] ?? all[0] ?? null
}
