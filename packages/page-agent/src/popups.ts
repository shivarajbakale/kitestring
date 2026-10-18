import { isRisky } from "@kitestring/protocol"
import { norm } from "./normalize.js"
import { nameOf, roleOf } from "./roles.js"
import type { RefRegistry } from "./refs.js"
import { elementLine } from "./snapshot.js"

export interface Closer {
  ref: string
  line: string
  kind: "cookie" | "newsletter"
}

const COOKIE_OVERLAY =
  "#onetrust-banner-sdk, #onetrust-consent-sdk, #CybotCookiebotDialog, #didomi-host, .qc-cmp2-container, #truste-consent-track, #usercentrics-root, " +
  "[id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], [aria-label*=cookie i]"
const NEWSLETTER_TEXT = /newsletter|subscribe|sign up|discount|% off/i
const NEWSLETTER_MIN_COVER = 0.3

/** Button-name patterns in order of preference. */
const COOKIE_BUTTONS = [
  /\b(reject|decline|deny|refuse)\b|necessary only|only necessary|essential only|only essential/,
  /\b(accept|agree|allow|ok|okay|got it)\b/
]
const NEWSLETTER_BUTTONS = [/^(close|dismiss|×|✕|✖|x)$|\b(close|dismiss|no,? thanks?|not now)\b/]

function isFixed(el: Element): boolean {
  return el.ownerDocument.defaultView!.getComputedStyle(el).position === "fixed"
}

function coversEnough(el: Element): boolean {
  const win = el.ownerDocument.defaultView!
  const r = el.getBoundingClientRect()
  return r.width * r.height >= NEWSLETTER_MIN_COVER * win.innerWidth * win.innerHeight
}

function isNewsletterOverlay(el: Element): boolean {
  const modal = el.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')
  if (!modal && !(isFixed(el) && coversEnough(el))) return false
  return NEWSLETTER_TEXT.test(el.textContent ?? "")
}

/** Outermost ancestor-or-self of `top` satisfying `pred`. */
function outermost(top: Element, pred: (e: Element) => boolean): Element | null {
  let found: Element | null = null
  for (let e: Element | null = top; e && e !== e.ownerDocument.documentElement; e = e.parentElement) {
    if (e !== e.ownerDocument.body && pred(e)) found = e
  }
  return found
}

function pick(overlay: Element, patterns: RegExp[]): Element | null {
  const buttons = Array.from(overlay.querySelectorAll("*")).filter((e) => {
    if (roleOf(e) !== "button") return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  for (const re of patterns) {
    for (const b of buttons) {
      const name = nameOf(b)
      if (name && !isRisky(name) && re.test(norm(name))) return b
    }
  }
  return null
}

/** For a click target covered by a cookie wall or newsletter modal: the safest control that dismisses it. */
export function closerFor(doc: Document, reg: RefRegistry, el: Element | null): Closer | null {
  if (!el || !el.isConnected) return null
  const r = el.getBoundingClientRect()
  const top = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  if (!top || top === el || el.contains(top)) return null

  const cookie = outermost(top, (e) => e.matches(COOKIE_OVERLAY))
  if (cookie) {
    const b = pick(cookie, COOKIE_BUTTONS)
    if (b) return { ref: reg.refFor(b), line: elementLine(b, "button", reg), kind: "cookie" }
  }
  const news = outermost(top, isNewsletterOverlay)
  if (news) {
    const b = pick(news, NEWSLETTER_BUTTONS)
    if (b) return { ref: reg.refFor(b), line: elementLine(b, "button", reg), kind: "newsletter" }
  }
  return null
}
