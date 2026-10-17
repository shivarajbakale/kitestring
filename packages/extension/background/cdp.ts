import { isRestrictedUrl } from "./agent-bridge"
import { RestrictedPageError } from "./errors"

export type CdpEvent = { method: string; params: Record<string, unknown> }
type Handler = (e: CdpEvent) => void

const PROTOCOL_VERSION = "1.3"

/** Tabs we are attached to (or attaching to). Cleared on detach / tab close. */
const attached = new Map<number, Promise<void>>()
const handlers = new Map<number, Set<Handler>>()
/** Run right after attaching, before the domains are enabled (so their replayed events are seen). */
const attachHooks = new Set<(tabId: number) => void>()

export function onAttach(hook: (tabId: number) => void): void {
  attachHooks.add(hook)
}

/** attach() failures that mean "the browser won't let extensions debug this page". */
const CANNOT_ATTACH_RE = /cannot access|cannot attach|chrome:\/\/|chrome-extension:\/\/|extensions gallery/i
const ALREADY_ATTACHED_RE = /already attached/i

/** Register the chrome.debugger / chrome.tabs listeners. Call once, synchronously, at service-worker start. */
export function initCdp(): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return
    const set = handlers.get(source.tabId)
    if (!set) return
    const e = { method, params: (params ?? {}) as Record<string, unknown> }
    for (const h of [...set]) h(e)
  })
  // The user cancelled the infobar, the tab navigated somewhere undebuggable, or the tab closed:
  // forget the attachment so the next action re-attaches.
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) attached.delete(source.tabId)
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId)
    handlers.delete(tabId)
  })
}

async function tabUrl(tabId: number): Promise<string> {
  const t = await chrome.tabs.get(tabId)
  return t.url || t.pendingUrl || ""
}

/** Attaches the debugger to the tab (once) and enables the Page, Network, Runtime and Log domains. */
export function ensureAttached(tabId: number): Promise<void> {
  let p = attached.get(tabId)
  if (!p) {
    p = (async () => {
      const url = await tabUrl(tabId)
      // about:blank is debuggable: attaching there lets tab.new / page.goto capture the first load.
      if (url !== "about:blank" && isRestrictedUrl(url)) throw new RestrictedPageError(url)
      try {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (CANNOT_ATTACH_RE.test(message)) throw new RestrictedPageError(url)
        // E.g. the service worker restarted while Chrome kept our session: reuse it.
        if (!ALREADY_ATTACHED_RE.test(message)) throw e
      }
      for (const hook of attachHooks) hook(tabId)
      await send(tabId, "Page.enable")
      await send(tabId, "Network.enable")
      await send(tabId, "Runtime.enable")
      await send(tabId, "Log.enable")
    })()
    attached.set(tabId, p)
    p.catch(() => {
      if (attached.get(tabId) === p) attached.delete(tabId)
    })
  }
  return p
}

const NOT_ATTACHED_RE = /not attached/i

export function isNotAttached(e: unknown): boolean {
  return NOT_ATTACHED_RE.test(e instanceof Error ? e.message : String(e))
}

/**
 * Bound on one CDP command. Some never answer on their own (input that opens a JS alert(), a renderer
 * stuck in a busy loop); without a bound the action holding the tab lock would never unwind.
 */
const SEND_TIMEOUT_MS = 30_000

export async function send<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`CDP ${method} in tab ${tabId} did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    )
  })
  try {
    return (await Promise.race([chrome.debugger.sendCommand({ tabId }, method, params), timeout])) as T
  } catch (e) {
    // Detached behind our back (no onDetach seen): forget it so the next ensureAttached re-attaches.
    if (isNotAttached(e)) attached.delete(tabId)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** Subscribes to CDP events from the tab. Returns the unsubscribe function. */
export function onEvent(tabId: number, handler: Handler): () => void {
  let set = handlers.get(tabId)
  if (!set) {
    set = new Set()
    handlers.set(tabId, set)
  }
  set.add(handler)
  return () => {
    handlers.get(tabId)?.delete(handler)
  }
}
