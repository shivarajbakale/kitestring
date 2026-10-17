import { READY } from "@kitestring/protocol"

function isVisible(win: Window, el: Element): boolean {
  const cs = win.getComputedStyle(el)
  if (cs.display === "none" || cs.visibility !== "visible") return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function busy(win: Window): boolean {
  const els = win.document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')
  return Array.from(els).some((el) => isVisible(win, el))
}

/** Resolve once the DOM has been quiet for opts.quietMs and nothing visible is busy. */
export function waitQuiet(
  win: Window,
  opts: { quietMs: number; timeoutMs: number } = READY
): Promise<{ quiet: boolean; waitedMs: number }> {
  return new Promise((resolve) => {
    const start = win.performance.now()
    let lastMutation = start
    const observer = new (win as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver((records) => {
      if (records.some((r) => !(r.type === "attributes" && r.attributeName === "style"))) {
        lastMutation = win.performance.now()
      }
    })
    observer.observe(win.document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true
    })
    const finish = (quiet: boolean): void => {
      observer.disconnect()
      win.clearInterval(timer)
      resolve({ quiet, waitedMs: Math.round(win.performance.now() - start) })
    }
    const tick = (): void => {
      const now = win.performance.now()
      if (busy(win)) lastMutation = now
      if (now - lastMutation >= opts.quietMs) finish(true)
      else if (now - start >= opts.timeoutMs) finish(false)
    }
    const timer = win.setInterval(tick, 50)
  })
}
