import { INTERACTIVE_ROLES, PATH_ROLES, nameOf, roleOf } from "./roles.js"

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function makeRef(role: string, name: string, path: string, occurrence: number): string {
  const h = fnv1a(`${role}|${name}|${path}|${occurrence}`)
  return "@e" + h.toString(36).padStart(5, "0").slice(-5)
}

export function landmarkPath(el: Element): string {
  const parts: string[] = []
  for (let p = el.parentElement; p; p = p.parentElement) {
    const r = roleOf(p)
    if (r && PATH_ROLES.has(r)) parts.push(nameOf(p) || r)
  }
  return parts.reverse().join("/")
}

export class RefRegistry {
  private refToEl = new Map<string, WeakRef<Element>>()
  private elToRef = new WeakMap<Element, string>()

  constructor(private doc: Document) {}

  /** Assign refs to every interactive element in document order (visibility-independent). */
  rescan(): void {
    const counts = new Map<string, number>()
    const used = new Set<string>()
    for (const el of Array.from(this.doc.querySelectorAll("*"))) {
      const role = roleOf(el)
      if (!role || !INTERACTIVE_ROLES.has(role)) continue
      const name = nameOf(el)
      const path = landmarkPath(el)
      const key = `${role}|${name}|${path}`
      let occ = counts.get(key) ?? 0
      let ref: string
      do {
        ref = makeRef(role, name, path, occ++)
      } while (used.has(ref))
      counts.set(key, occ)
      used.add(ref)
      this.elToRef.set(el, ref)
      this.refToEl.set(ref, new WeakRef(el))
    }
  }

  refFor(el: Element): string {
    let ref = this.elToRef.get(el)
    if (!ref || this.refToEl.get(ref)?.deref() !== el) {
      this.rescan()
      ref = this.elToRef.get(el)
    }
    if (!ref) throw new Error("element is not an interactive element")
    return ref
  }

  resolve(ref: string): Element | null {
    const cached = this.refToEl.get(ref)?.deref()
    if (cached && cached.isConnected) return cached
    this.rescan()
    const el = this.refToEl.get(ref)?.deref()
    if (el && el.isConnected) return el
    this.refToEl.delete(ref)
    return null
  }
}
