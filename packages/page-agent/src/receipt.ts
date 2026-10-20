import { check } from "./check.js"
import { INTERACTIVE_ROLES, nameOf, roleOf } from "./roles.js"

/**
 * The last check before a click goes out, and what the click did. `armClick` re-checks the element right before the
 * input (still attached, not moving, nothing covering its centre) and starts listening; `clickReceipt` says whether
 * the element itself received the press and whether the DOM changed since. A click whose press never reached the
 * element (it was replaced or moved in between) did nothing and is safe to send again.
 */
export type ArmResult =
  | { kind: "ok"; x: number; y: number }
  | { kind: "gone" }
  | { kind: "moving" }
  | { kind: "blocked"; by: string }
  | { kind: "disabled" }
  | { kind: "hidden" }

export interface Receipt {
  /**
   * A trusted pointerdown, mousedown or click reached the element (or something inside it), or its twin: an element
   * with the same role and name in its place (a framework re-rendered it).
   */
  received: boolean
  /** The press reached another control instead (`button "Cancel"`): it may have done something. */
  landedOn?: string
  /** DOM changes since arming (style-only attribute changes do not count). */
  mutations: number
  connected: boolean
}

interface Armed {
  el: Element
  received: boolean
  landedOn?: string
  mutations: number
  stop: () => void
}

/** The nearest control at or above `n` (through shadow roots): its role and name, else null. */
function controlOf(n: EventTarget | null): { el: Element; role: string; name: string } | null {
  for (let e = n instanceof Element ? n : null; e; e = e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null)) {
    const role = roleOf(e)
    if (role && INTERACTIVE_ROLES.has(role)) return { el: e, role, name: nameOf(e) }
  }
  return null
}

/** Moved more than this (CSS px) across two frames: still animating. */
const MOVE_TOLERANCE = 0.5
/** Two frames, or this long when frames are slow (a busy main thread). */
const FRAMES_CAP_MS = 100

function twoFrames(win: Window): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    win.setTimeout(finish, FRAMES_CAP_MS)
    win.requestAnimationFrame(() => win.requestAnimationFrame(finish))
  })
}

export class ClickReceipts {
  private armed: Armed | null = null

  constructor(private win: Window) {}

  async arm(el: Element | null): Promise<ArmResult> {
    this.disarm()
    if (!el || !el.isConnected) return { kind: "gone" }
    const first = check(el)
    if (first.kind !== "ok") return first.kind === "disabled" ? { kind: "disabled" } : first
    const before = el.getBoundingClientRect()
    await twoFrames(this.win)
    if (!el.isConnected) return { kind: "gone" }
    const after = el.getBoundingClientRect()
    if (
      Math.abs(after.x - before.x) > MOVE_TOLERANCE ||
      Math.abs(after.y - before.y) > MOVE_TOLERANCE ||
      Math.abs(after.width - before.width) > MOVE_TOLERANCE ||
      Math.abs(after.height - before.height) > MOVE_TOLERANCE
    ) {
      return { kind: "moving" }
    }
    const now = check(el)
    if (now.kind !== "ok") return now.kind === "disabled" ? { kind: "disabled" } : now

    const a: Armed = { el, received: false, mutations: 0, stop: () => {} }
    const role = roleOf(el)
    const name = nameOf(el)
    const onPress = (e: Event) => {
      if (!e.isTrusted || a.received) return
      if (e.composedPath().includes(el)) {
        a.received = true
        return
      }
      const hit = controlOf(e.composedPath()[0] ?? e.target)
      if (!hit) return
      if (hit.role === role && hit.name === name) a.received = true
      else a.landedOn ??= hit.name ? `${hit.role} ${JSON.stringify(hit.name)}` : hit.role
    }
    const types = ["pointerdown", "mousedown", "click"] as const
    for (const t of types) this.win.addEventListener(t, onPress, true)
    const observer = new (this.win as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver((records) => {
      for (const r of records) if (!(r.type === "attributes" && r.attributeName === "style")) a.mutations++
    })
    observer.observe(this.win.document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
    a.stop = () => {
      for (const t of types) this.win.removeEventListener(t, onPress, true)
      observer.disconnect()
    }
    this.armed = a
    return now
  }

  /** What the armed click did so far; `disarm` stops listening. Null when nothing is armed. */
  receipt(disarm: boolean): Receipt | null {
    const a = this.armed
    if (!a) return null
    const r: Receipt = { received: a.received, mutations: a.mutations, connected: a.el.isConnected }
    if (!a.received && a.landedOn) r.landedOn = a.landedOn
    if (disarm) this.disarm()
    return r
  }

  disarm(): void {
    this.armed?.stop()
    this.armed = null
  }
}
