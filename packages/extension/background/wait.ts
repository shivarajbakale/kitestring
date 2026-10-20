import { ErrorCode, READY, parseTarget, type Target } from "@kitestring/protocol"
import type { WaitCondition, WaitResult } from "@kitestring/page-agent"
import { callAgent } from "./agent-bridge"
import { urlMatches } from "./batch-result"
import { ensureAttached, hold, send } from "./cdp"
import { RpcError } from "./errors"
import { trackNetwork } from "./network-idle"

/**
 * `page.wait` conditions. selector / target / text / count are checked by the page agent as the DOM changes; url,
 * fn and idle here. Every kind outlives a navigation: a wait whose document goes away carries on in the next one.
 */
export type Condition =
  | WaitCondition
  | { url: string }
  /** Source of a function run in the page's own world, called with `arg` until it returns something truthy. */
  | { fn: string; arg?: unknown }
  | { idle: true }

/** One page-agent call waits at most this long: a navigation in between costs at most one short retry. */
const AGENT_CHUNK_MS = 5_000
const POLL_MS = 100
/** A wait function's own polling interval, in the page. */
const FN_POLL_MS = 50
/** Mistakes in the condition itself: waiting longer will not fix them. */
const BAD_CONDITION_RE = /is not a valid selector|Invalid regular expression|Invalid flags/

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

function badRequest(message: string): never {
  throw new RpcError(ErrorCode.BAD_REQUEST, message)
}

/** Validates a raw condition (the caller's JSON). String targets become Target objects. */
export function parseCondition(raw: unknown): Condition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) badRequest("params.cond must be an object")
  const c = raw as Record<string, unknown>
  const str = (k: string) => {
    if (typeof c[k] !== "string" || !(c[k] as string)) badRequest(`params.cond.${k} must be a non-empty string`)
    return c[k] as string
  }
  const kinds = ["selector", "target", "text", "count", "url", "fn", "idle"].filter((k) => c[k] !== undefined)
  if (kinds.length !== 1) badRequest(`params.cond needs exactly one of selector, target, text, count, url, fn, idle (got ${kinds.join(", ") || "none"})`)
  switch (kinds[0]) {
    case "selector": {
      const state = c.state ?? "visible"
      if (!["attached", "detached", "visible", "hidden"].includes(state as string)) badRequest("params.cond.state must be attached, detached, visible or hidden")
      return { selector: str("selector"), state: state as "visible" }
    }
    case "target": {
      const t = c.target
      const within = typeof c.within === "string" ? c.within : undefined
      const role = typeof c.role === "string" ? c.role : undefined
      if (typeof t === "string" && t) return { target: parseTarget(t, { within, role }) }
      if (t && typeof t === "object") return { target: t as Target }
      return badRequest("params.cond.target must be visible text or an @ref")
    }
    case "text":
      if (c.within !== undefined && typeof c.within !== "string") badRequest("params.cond.within must be a string")
      return { text: str("text"), ...(c.within !== undefined ? { within: c.within as string } : {}), ...(c.gone === true ? { gone: true } : {}) }
    case "count": {
      const n = c.count as { selector?: unknown; min?: unknown } | null
      if (!n || typeof n.selector !== "string" || !n.selector || typeof n.min !== "number" || !Number.isInteger(n.min) || n.min < 0) {
        badRequest("params.cond.count must be {selector, min} with min a whole number")
      }
      return { count: { selector: n.selector as string, min: n.min as number } }
    }
    case "url":
      return { url: str("url") }
    case "fn":
      return { fn: str("fn"), ...(c.arg !== undefined ? { arg: c.arg } : {}) }
    default:
      if (c.idle !== true) badRequest("params.cond.idle must be true")
      return { idle: true }
  }
}

/** For the timeout message. */
function describe(c: Condition): string {
  if ("selector" in c) return `${JSON.stringify(c.selector)} to be ${c.state ?? "visible"}`
  if ("target" in c) return `${"ref" in c.target ? c.target.ref : JSON.stringify(c.target.text)} to appear`
  if ("text" in c) return `text ${JSON.stringify(c.text)} ${c.gone ? "to go away" : "to appear"}${c.within !== undefined ? ` in ${JSON.stringify(c.within)}` : ""}`
  if ("count" in c) return `${c.count.min} ${JSON.stringify(c.count.selector)}`
  if ("url" in c) return `the URL to match ${JSON.stringify(c.url)}`
  if ("fn" in c) return "the wait function to return a truthy value"
  return "the page to go idle"
}

async function tabUrl(tabId: number): Promise<string> {
  const t = await chrome.tabs.get(tabId)
  return t.url || t.pendingUrl || ""
}

/**
 * Waits until `cond` holds in the tab, up to `ms`. Resolves `{ms}` (and a wait function's value as `value`); throws
 * TIMEOUT naming what was last seen, or BAD_REQUEST for a condition that can never be checked.
 */
export async function waitInTab(tabId: number, cond: Condition, ms: number): Promise<{ ms: number; value?: unknown }> {
  const t0 = Date.now()
  const deadline = t0 + ms
  const left = () => deadline - Date.now()
  const timeout = (seen: string): never => {
    throw new RpcError(ErrorCode.TIMEOUT, `TIMEOUT: waited ${ms} ms for ${describe(cond)}${seen ? `: ${seen}` : ""}`)
  }

  if ("url" in cond) {
    for (;;) {
      const url = await tabUrl(tabId)
      if (urlMatches(url, cond.url)) return { ms: Date.now() - t0 }
      if (left() <= 0) timeout(`the page is at ${url}`)
      await sleep(Math.min(POLL_MS, left()))
    }
  }

  if ("idle" in cond) {
    const release = hold(tabId)
    try {
      await ensureAttached(tabId)
      const net = trackNetwork(tabId)
      try {
        const [idle, q] = await Promise.all([
          net.waitIdle(READY.quietMs, ms),
          Promise.race([callAgent<{ quiet: boolean }>(tabId, "waitQuiet", []).catch(() => ({ quiet: false })), sleep(ms).then(() => ({ quiet: false }))]),
        ])
        if (idle && q.quiet) return { ms: Date.now() - t0 }
        return timeout(idle ? "the page kept changing" : "requests were still in flight")
      } finally {
        net.stop()
      }
    } finally {
      release()
    }
  }

  if ("fn" in cond) {
    const release = hold(tabId)
    try {
      for (;;) {
        const chunk = Math.max(0, Math.min(AGENT_CHUNK_MS, left()))
        const expression = `(async (f, arg, ms) => {
          const end = Date.now() + ms
          for (;;) {
            const v = await f(arg)
            if (v) return { ok: true, value: v }
            if (Date.now() >= end) return { ok: false }
            await new Promise((r) => setTimeout(r, ${FN_POLL_MS}))
          }
        })((${cond.fn}), ${cond.arg === undefined ? "undefined" : JSON.stringify(cond.arg)}, ${chunk})`
        let r: { result: { value?: { ok: boolean; value?: unknown } }; exceptionDetails?: { text: string; exception?: { description?: string } } }
        try {
          await ensureAttached(tabId)
          r = await send(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
        } catch {
          // The document went away mid-wait (navigation): try again in the next one.
          if (left() <= 0) timeout("the page navigated while waiting")
          await sleep(POLL_MS)
          continue
        }
        if (r.exceptionDetails) {
          const d = r.exceptionDetails
          badRequest(`wait function threw: ${(d.exception?.description ?? d.text).split("\n")[0]}`)
        }
        const v = r.result.value
        if (v?.ok) return { ms: Date.now() - t0, ...(v.value !== true ? { value: v.value } : {}) }
        if (left() <= 0) timeout("")
      }
    } finally {
      release()
    }
  }

  let seen = ""
  for (;;) {
    const chunk = Math.max(0, Math.min(AGENT_CHUNK_MS, left()))
    let r: WaitResult
    try {
      r = await callAgent<WaitResult>(tabId, "waitFor", [cond, chunk])
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (BAD_CONDITION_RE.test(m)) badRequest(m)
      // The page agent went away with its document: carry on in the next one.
      if (left() <= 0) timeout(seen || "the page navigated while waiting")
      await sleep(POLL_MS)
      continue
    }
    if (r.ok) return { ms: Date.now() - t0 }
    seen = r.seen
    if (left() <= 0) timeout(seen)
  }
}
