import type { Target } from "@kitestring/protocol"
import { find, scopesNamed } from "./find.js"
import type { RefRegistry } from "./refs.js"

/**
 * A condition `waitFor` waits on in the page (url, fn and idle are the background's: they outlive a navigation or
 * need the page's own world). `selector` states: attached (in the DOM), detached (not), visible (some match is
 * visible), hidden (none is). `target` is found like an action's target; `text` is a case-folded substring of the
 * visible text (of the `within` scope if given), or a /regex/; `gone` waits for it to disappear.
 */
export type WaitCondition =
  | { selector: string; state?: "attached" | "detached" | "visible" | "hidden" }
  | { target: Target }
  | { text: string; within?: string; gone?: boolean }
  | { count: { selector: string; min: number } }

export type WaitResult = { ok: true } | { ok: false; seen: string }

/** Re-check at least this often, for changes no mutation reports (layout, scrolling, CSS animations). */
const POLL_MS = 100
/** ...and at most this often while the DOM keeps changing (a live feed). */
const MIN_GAP_MS = 30

const fold = (s: string): string => s.replace(/\s+/g, " ").toLowerCase()

function isVisible(win: Window, el: Element): boolean {
  const cs = win.getComputedStyle(el)
  if (cs.display === "none" || cs.visibility !== "visible") return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function textMatcher(text: string): (s: string) => boolean {
  const re = /^\/(.+)\/([a-z]*)$/.exec(text)
  if (re) {
    const r = new RegExp(re[1]!, re[2]!.includes("i") ? re[2] : `${re[2]}i`)
    return (s) => r.test(s)
  }
  const want = fold(text)
  return (s) => fold(s).includes(want)
}

/** Throws on a bad selector or regex (the caller's mistake: no point waiting). */
export function compile(doc: Document, reg: RefRegistry, cond: WaitCondition): () => WaitResult {
  const win = doc.defaultView!
  if ("selector" in cond) {
    doc.querySelector(cond.selector) // throws SyntaxError on a bad selector
    const state = cond.state ?? "visible"
    return () => {
      const all = Array.from(doc.querySelectorAll(cond.selector))
      const visible = all.filter((e) => isVisible(win, e)).length
      const ok =
        state === "attached" ? all.length > 0 : state === "detached" ? all.length === 0 : state === "visible" ? visible > 0 : visible === 0
      return ok ? { ok } : { ok, seen: `${all.length} match${all.length === 1 ? "es" : ""} ${JSON.stringify(cond.selector)}, ${visible} visible` }
    }
  }
  if ("count" in cond) {
    doc.querySelector(cond.count.selector)
    return () => {
      const n = doc.querySelectorAll(cond.count.selector).length
      return n >= cond.count.min ? { ok: true } : { ok: false, seen: `${n} of ${cond.count.min} ${JSON.stringify(cond.count.selector)}` }
    }
  }
  if ("target" in cond) {
    return () => {
      const f = find(doc, reg, cond.target, "click")
      // Ambiguous still means it is there.
      return f.kind === "not_found" ? { ok: false, seen: "no element matches" } : { ok: true }
    }
  }
  const matches = textMatcher(cond.text)
  return () => {
    let texts: string[]
    if (cond.within !== undefined) {
      const scopes = scopesNamed(doc, cond.within)
      if (!scopes.length && !cond.gone) return { ok: false, seen: `no section named ${JSON.stringify(cond.within)}` }
      texts = scopes.map((s) => (s as HTMLElement).innerText ?? s.textContent ?? "")
    } else texts = [doc.body?.innerText ?? ""]
    const present = texts.some(matches)
    const ok = cond.gone ? !present : present
    if (ok) return { ok }
    return { ok, seen: cond.gone ? "the text is still on the page" : `the text is not on the page${cond.within !== undefined ? ` (in ${JSON.stringify(cond.within)})` : ""}` }
  }
}

/** Resolves as soon as the condition holds, or with what was last seen after `ms`. */
export function waitFor(doc: Document, reg: RefRegistry, cond: WaitCondition, ms: number): Promise<WaitResult> {
  const win = doc.defaultView!
  const test = compile(doc, reg, cond)
  const first = test()
  if (first.ok || ms <= 0) return Promise.resolve(first)
  return new Promise((resolve) => {
    let last: WaitResult = first
    let lastRun = win.performance.now()
    let pending: number | undefined
    const done = (r: WaitResult) => {
      observer.disconnect()
      win.clearInterval(poll)
      win.clearTimeout(deadline)
      if (pending !== undefined) win.clearTimeout(pending)
      resolve(r)
    }
    const run = () => {
      pending = undefined
      lastRun = win.performance.now()
      try {
        last = test()
      } catch {
        return
      }
      if (last.ok) done(last)
    }
    const soon = () => {
      if (pending !== undefined) return
      pending = win.setTimeout(run, Math.max(0, MIN_GAP_MS - (win.performance.now() - lastRun)))
    }
    const observer = new (win as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver(soon)
    observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
    const poll = win.setInterval(run, POLL_MS)
    const deadline = win.setTimeout(() => {
      run()
      if (!last.ok) done(last)
    }, ms)
  })
}
