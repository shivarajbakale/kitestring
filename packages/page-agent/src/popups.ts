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

/** Consent-management platforms: their banners may say "Accept" without the word cookie. */
const KNOWN_CMP =
  "#onetrust-banner-sdk, #onetrust-consent-sdk, #CybotCookiebotDialog, #didomi-host, .qc-cmp2-container, #truste-consent-track, #usercentrics-root"
const COOKIE_OVERLAY =
  KNOWN_CMP + ", [id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], [aria-label*=cookie i]"
const NEWSLETTER_TEXT = /newsletter|subscribe|sign up|discount|% off/i
const NEWSLETTER_MIN_COVER = 0.3

type Want = (button: Element, name: string) => boolean
const named =
  (re: RegExp): Want =>
  (_b, name) =>
    re.test(name)

/** Reject-style names: always safe to click on a cookie banner. */
const COOKIE_REJECT = named(/\b(reject|decline|deny|refuse)\b|necessary only|only necessary|essential only|only essential/)
/** Accept-style names: only on a known CMP, or an overlay that says "cookie" (see closerFor). */
const COOKIE_ACCEPT = named(/\b(accept|agree|allow|ok|okay|got it)\b/)
/** Newsletter dismissers, in order of preference; whole names only ("Close account" is not one). */
const NEWSLETTER_BUTTONS: Want[] = [
  named(/^close$/),
  named(/^no,? thanks?\b/),
  (b) => /^(close|dismiss)\b/i.test(norm(b.getAttribute("aria-label") ?? "")),
  named(/^(×|✕|✖|x)$/),
  named(/^(dismiss|not now)$/),
]

function isFixed(el: Element): boolean {
  return el.ownerDocument.defaultView!.getComputedStyle(el).position === "fixed"
}

function coversEnough(el: Element): boolean {
  const win = el.ownerDocument.defaultView!
  const r = el.getBoundingClientRect()
  return r.width * r.height >= NEWSLETTER_MIN_COVER * win.innerWidth * win.innerHeight
}

function isNewsletterOverlay(el: Element): boolean {
  const modal = el.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')
  if (!modal && !(isFixed(el) && coversEnough(el))) return false
  return NEWSLETTER_TEXT.test(el.textContent ?? "")
}

/**
 * Ancestors-or-self of `top` satisfying `pred`, innermost first, stopping at the first that contains
 * `target`: an overlay never wraps what it covers (a page-wide `class="has-cookie-banner"` wrapper does).
 */
function overlays(top: Element, target: Element, pred: (e: Element) => boolean): Element[] {
  const out: Element[] = []
  for (let e: Element | null = top; e && e !== e.ownerDocument.documentElement; e = e.parentElement) {
    if (e === e.ownerDocument.body || e.contains(target)) break
    if (pred(e)) out.push(e)
  }
  return out
}

function pick(overlay: Element, wants: Want[]): Element | null {
  const buttons = Array.from(overlay.querySelectorAll("*")).filter((e) => {
    if (roleOf(e) !== "button") return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  for (const want of wants) {
    for (const b of buttons) {
      const name = nameOf(b)
      if (name && !isRisky(name) && want(b, norm(name))) return b
    }
  }
  return null
}

/** Accepting is only safe where the overlay is plainly about cookies. */
function cookieWants(overlay: Element): Want[] {
  const aboutCookies = overlay.matches(KNOWN_CMP) || /cookie/i.test(overlay.textContent ?? "")
  return aboutCookies ? [COOKIE_REJECT, COOKIE_ACCEPT] : [COOKIE_REJECT]
}

/** For a click target covered by a cookie wall or newsletter modal: the safest control that dismisses it. */
export function closerFor(doc: Document, reg: RefRegistry, el: Element | null): Closer | null {
  if (!el || !el.isConnected) return null
  const r = el.getBoundingClientRect()
  const top = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  if (!top || top === el || el.contains(top)) return null

  for (const cookie of overlays(top, el, (e) => e.matches(COOKIE_OVERLAY))) {
    const b = pick(cookie, cookieWants(cookie))
    if (b) return { ref: reg.refFor(b), line: elementLine(b, "button", reg), kind: "cookie" }
  }
  for (const news of overlays(top, el, isNewsletterOverlay)) {
    const b = pick(news, NEWSLETTER_BUTTONS)
    if (b) return { ref: reg.refFor(b), line: elementLine(b, "button", reg), kind: "newsletter" }
  }
  return null
}
