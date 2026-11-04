import {
  ErrorCode,
  REF_RE,
  type ConsoleEntry,
  type ConsoleLevel,
  type NetworkEntry,
  type ScreenshotResult,
} from "@kitestring/protocol"
import { callAgent } from "./agent-bridge"
import { ensureAttached, onAttach, onEvent, send } from "./cdp"
import { RestrictedPageError, RpcError } from "./errors"
import { withTabLock } from "./serial"

export const RING_SIZE = 500
export const MAX_TEXT = 2000
/** Response bodies kept per tab (JSON and text from fetch / XHR), newest; a larger one is not kept. */
export const BODY_RING = 40
export const BODY_MAX_CHARS = 2_000_000
const BODY_TOTAL_CHARS = 8_000_000
/** Responses worth keeping: what an app fetches its data as. */
const BODY_TYPES = new Set(["Fetch", "XHR"])
const BODY_MIME = /json|javascript|text\/plain|text\/html|x-protobuf-json/i

type Params = Record<string, unknown>

interface RemoteObject {
  type?: string
  value?: unknown
  description?: string
  unserializableValue?: string
}

interface CallFrame {
  url?: string
  lineNumber?: number
}

const CONSOLE_LEVELS: Record<string, ConsoleLevel> = {
  log: "log",
  info: "info",
  warning: "warn",
  warn: "warn",
  error: "error",
  assert: "error",
  debug: "debug",
  verbose: "debug",
  trace: "debug",
}

function argText(a: RemoteObject): string {
  if (a.value !== undefined) {
    if (typeof a.value === "string") return a.value
    try {
      return JSON.stringify(a.value) ?? String(a.value)
    } catch {
      return String(a.value)
    }
  }
  return a.description ?? a.unserializableValue ?? a.type ?? ""
}

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s)

function push<T>(buf: T[], e: T): T | undefined {
  buf.push(e)
  return buf.length > RING_SIZE ? buf.shift() : undefined
}

/** The buffers of one tab, fed with CDP events. Pure (no chrome.* access) so it is unit-testable. */
export class TabCapture {
  readonly console: ConsoleEntry[] = []
  readonly network: NetworkEntry[] = []
  /** Main-frame navigations seen so far. */
  nav = 0
  /** Keep entries across main-frame navigations (default). */
  preserve = true
  /** requestId → live entry plus its monotonic start time, until the request finishes. */
  private open = new Map<string, { e: NetworkEntry; t0: number }>()
  /**
   * Source timestamp + level + text of recent console events. Runtime.enable / Log.enable replay stored
   * messages on every (re-)attach; the same event must not be recorded twice (nor resurrect after clear).
   */
  private seen = new Set<string>()
  private seenOrder: string[] = []
  /** Called when a finished response's body is worth keeping; the owner fetches it and hands it to keepBody. */
  wantBody?: (requestId: string, e: NetworkEntry) => void
  private bodies = new Map<number, { e: NetworkEntry; text: string }>()
  private bodyChars = 0
  private bodySeq = 0

  /** Keeps a response body for `e` (dropping the oldest past BODY_RING / the total budget). */
  keepBody(e: NetworkEntry, text: string): void {
    if (text.length > BODY_MAX_CHARS || !this.network.includes(e)) return
    const id = ++this.bodySeq
    e.bodyId = id
    e.bodyChars = text.length
    this.bodies.set(id, { e, text })
    this.bodyChars += text.length
    for (const [old, b] of this.bodies) {
      if (this.bodies.size <= BODY_RING && this.bodyChars <= BODY_TOTAL_CHARS) break
      this.bodies.delete(old)
      this.bodyChars -= b.text.length
      delete b.e.bodyId
      delete b.e.bodyChars
    }
  }

  /** One kept body, whole. */
  body(id: number): { url: string; method: string; status?: number; mime?: string; body: string } | undefined {
    const b = this.bodies.get(id)
    if (!b) return undefined
    return { url: b.e.url, method: b.e.method, ...(b.e.status !== undefined ? { status: b.e.status } : {}), ...(b.e.mime ? { mime: b.e.mime } : {}), body: b.text }
  }

  private clearBodies(): void {
    this.bodies.clear()
    this.bodyChars = 0
  }

  private firstSeen(key: string): boolean {
    if (this.seen.has(key)) return false
    this.seen.add(key)
    this.seenOrder.push(key)
    if (this.seenOrder.length > RING_SIZE * 2) this.seen.delete(this.seenOrder.shift()!)
    return true
  }

  onEvent(method: string, p: Params, now = Date.now()): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const args = (p.args as RemoteObject[] | undefined) ?? []
        const frame = (p.stackTrace as { callFrames?: CallFrame[] } | undefined)?.callFrames?.[0]
        this.addConsole(CONSOLE_LEVELS[p.type as string] ?? "log", args.map(argText).join(" "), frame?.url, frame?.lineNumber, now, p.timestamp)
        break
      }
      case "Runtime.exceptionThrown": {
        const d = (p.exceptionDetails ?? {}) as {
          text?: string
          url?: string
          lineNumber?: number
          exception?: RemoteObject
          stackTrace?: { callFrames?: CallFrame[] }
        }
        const frame = d.stackTrace?.callFrames?.[0]
        const text = d.exception?.description ?? (d.exception ? argText(d.exception) : "")
        this.addConsole("error", text || d.text || "Uncaught", d.url ?? frame?.url, d.lineNumber ?? frame?.lineNumber, now, p.timestamp)
        break
      }
      case "Log.entryAdded": {
        const e = (p.entry ?? {}) as { level?: string; text?: string; url?: string; lineNumber?: number; timestamp?: number }
        this.addConsole(CONSOLE_LEVELS[e.level ?? "info"] ?? "info", e.text ?? "", e.url, e.lineNumber, now, e.timestamp)
        break
      }
      case "Page.frameNavigated": {
        const frame = p.frame as { parentId?: string } | undefined
        if (!frame || frame.parentId) break
        this.nav++
        if (!this.preserve) {
          this.console.length = 0
          this.network.length = 0
          this.open.clear()
          this.clearBodies()
        }
        break
      }
      case "Network.requestWillBeSent": {
        const id = p.requestId as string
        const req = (p.request ?? {}) as { url?: string; method?: string }
        const redirect = p.redirectResponse as { status?: number } | undefined
        const prev = this.open.get(id)
        if (prev && redirect) this.settle(id, p.timestamp as number | undefined, redirect.status)
        const e: NetworkEntry = {
          ts: now,
          method: req.method ?? "GET",
          url: req.url ?? "",
          type: (p.type as string | undefined) ?? "Other",
          failed: false,
          nav: this.nav,
        }
        this.open.set(id, { e, t0: (p.timestamp as number | undefined) ?? 0 })
        this.evict(push(this.network, e))
        break
      }
      case "Network.responseReceived": {
        const o = this.open.get(p.requestId as string)
        if (!o) break
        const r = (p.response ?? {}) as { status?: number; mimeType?: string }
        if (typeof r.mimeType === "string" && r.mimeType) o.e.mime = r.mimeType
        if (typeof r.status === "number") {
          o.e.status = r.status
          o.e.failed = r.status >= 400
        }
        if (typeof p.type === "string") o.e.type = p.type
        break
      }
      case "Network.loadingFinished": {
        const o = this.open.get(p.requestId as string)
        this.settle(p.requestId as string, p.timestamp as number | undefined)
        if (o && this.wantBody && BODY_TYPES.has(o.e.type) && BODY_MIME.test(o.e.mime ?? "") && !o.e.failed) this.wantBody(p.requestId as string, o.e)
        break
      }
      case "Network.loadingFailed": {
        const o = this.open.get(p.requestId as string)
        if (!o) break
        // A bodiless response (204/304) is reported as loadingFailed+canceled after a good responseReceived: not a failure.
        if (p.canceled && o.e.status !== undefined && o.e.status < 400) {
          this.settle(p.requestId as string, p.timestamp as number | undefined)
          break
        }
        o.e.failed = true
        o.e.error = p.canceled ? "canceled" : ((p.errorText as string | undefined) ?? "failed")
        this.settle(p.requestId as string, p.timestamp as number | undefined)
        break
      }
    }
  }

  private addConsole(level: ConsoleLevel, text: string, url: string | undefined, line0: number | undefined, ts: number, srcTs?: unknown): void {
    if (typeof srcTs === "number" && !this.firstSeen(`${srcTs}|${level}|${text}`)) return
    const e: ConsoleEntry = { ts, level, text: clip(text), nav: this.nav }
    if (url) e.url = url
    if (typeof line0 === "number") e.line = line0 + 1
    push(this.console, e)
  }

  private settle(id: string, timestamp: number | undefined, status?: number): void {
    const o = this.open.get(id)
    if (!o) return
    this.open.delete(id)
    if (status !== undefined) {
      o.e.status = status
      o.e.failed = status >= 400
    }
    if (timestamp !== undefined && o.t0) o.e.ms = Math.max(0, Math.round((timestamp - o.t0) * 1000))
  }

  private evict(gone: NetworkEntry | undefined): void {
    if (!gone) return
    if (gone.bodyId !== undefined) {
      const b = this.bodies.get(gone.bodyId)
      if (b) {
        this.bodies.delete(gone.bodyId)
        this.bodyChars -= b.text.length
      }
    }
    for (const [id, o] of this.open) if (o.e === gone) this.open.delete(id)
  }

  consoleEntries(opts: { level?: "error" | "warn" | "all"; limit?: number; clear?: boolean } = {}): ConsoleEntry[] {
    const level = opts.level ?? "all"
    const match = (e: ConsoleEntry) =>
      level === "all" || (level === "error" ? e.level === "error" : e.level === "error" || e.level === "warn")
    const out = this.console.filter(match).slice(-(opts.limit ?? 50))
    if (opts.clear) this.console.length = 0
    return out
  }

  /** `bodies`: entries with a kept body carry it, cut to this many characters (and only such entries are listed). */
  networkEntries(opts: { failed?: boolean; filter?: string; limit?: number; clear?: boolean; bodies?: number } = {}): NetworkEntry[] {
    const out = this.network
      .filter((e) => (!opts.failed || e.failed) && (!opts.filter || e.url.includes(opts.filter)) && (opts.bodies === undefined || e.bodyId !== undefined))
      .slice(-(opts.limit ?? 50))
      .map((e) => {
        if (opts.bodies === undefined || e.bodyId === undefined) return { ...e }
        const text = this.bodies.get(e.bodyId)?.text ?? ""
        return { ...e, body: text.length > opts.bodies ? `${text.slice(0, opts.bodies)}…` : text }
      })
    if (opts.clear) {
      this.network.length = 0
      this.open.clear()
      this.clearBodies()
    }
    return out
  }
}

/** Width and height (px) from the IHDR chunk of a base64 PNG. */
export function pngSize(b64: string): { width: number; height: number } {
  const bin = atob(b64.slice(0, 32)) // 24 bytes of header need 32 base64 chars
  const u32 = (o: number) =>
    ((bin.charCodeAt(o) << 24) | (bin.charCodeAt(o + 1) << 16) | (bin.charCodeAt(o + 2) << 8) | bin.charCodeAt(o + 3)) >>> 0
  return { width: u32(16), height: u32(20) }
}

const captures = new Map<number, { cap: TabCapture; off: () => void }>()

/** Idempotent. Call before the CDP domains are enabled so Runtime/Log replay lands in the buffers. */
export function startCapture(tabId: number, opts: { preserve?: boolean } = {}): void {
  let c = captures.get(tabId)
  if (!c) {
    const cap = new TabCapture()
    cap.wantBody = (requestId, e) => {
      send<{ body: string; base64Encoded: boolean }>(tabId, "Network.getResponseBody", { requestId }, 10_000).then(
        (r) => {
          if (r.base64Encoded) {
            try {
              cap.keepBody(e, new TextDecoder().decode(Uint8Array.from(atob(r.body), (ch) => ch.charCodeAt(0))))
            } catch {
              /* not text */
            }
          } else cap.keepBody(e, r.body)
        },
        () => {}, // evicted from Chrome's buffer, or the tab navigated: nothing to keep
      )
    }
    c = { cap, off: onEvent(tabId, (e) => cap.onEvent(e.method, e.params)) }
    captures.set(tabId, c)
  }
  if (opts.preserve !== undefined) c.cap.preserve = opts.preserve
}

export function stopCapture(tabId: number): void {
  captures.get(tabId)?.off()
  captures.delete(tabId)
}

export function consoleEntries(tabId: number, opts: Parameters<TabCapture["consoleEntries"]>[0] = {}): ConsoleEntry[] {
  return captures.get(tabId)?.cap.consoleEntries(opts) ?? []
}

export function networkEntries(tabId: number, opts: Parameters<TabCapture["networkEntries"]>[0] = {}): NetworkEntry[] {
  return captures.get(tabId)?.cap.networkEntries(opts) ?? []
}

export function responseBody(tabId: number, id: number): ReturnType<TabCapture["body"]> {
  return captures.get(tabId)?.cap.body(id)
}

/** Call once at service-worker start. */
export function initCapture(): void {
  onAttach((tabId) => startCapture(tabId))
  chrome.tabs.onRemoved.addListener(stopCapture)
}

/** Makes sure the tab is attached (so capture runs). Restricted pages simply have nothing captured. */
export async function ensureCapturing(tabId: number): Promise<void> {
  try {
    await ensureAttached(tabId)
  } catch (e) {
    if (!(e instanceof RestrictedPageError)) throw e
  }
}

/**
 * Chrome cannot render a texture taller than this many device pixels; a full-page shot is clipped to it
 * (in CSS px: MAX_FULL_HEIGHT / devicePixelRatio) rather than failing.
 * (Its CDP command also gets its own, longer bound than the default 30 s.)
 */
export const MAX_FULL_HEIGHT = 16_384
export const SCREENSHOT_TIMEOUT_MS = 45_000

/** How long a screenshot waits for an action holding the tab before giving up. */
const LOCK_WAIT_MS = 15_000

/** Serialized with actions on the tab: the element path scrolls the page, which must not land mid-click. */
export async function screenshot(tabId: number, opts: { full?: boolean; ref?: string }): Promise<ScreenshotResult> {
  if (opts.ref !== undefined && !REF_RE.test(opts.ref)) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `params.ref must look like @e12abc, got ${opts.ref}`)
  }
  const wait = new AbortController()
  const timer = setTimeout(
    () => wait.abort(new RpcError(ErrorCode.TIMEOUT, `TIMEOUT: tab ${tabId} stayed busy for ${LOCK_WAIT_MS} ms; screenshot not taken`)),
    LOCK_WAIT_MS,
  )
  try {
    return await withTabLock(tabId, async () => (clearTimeout(timer), shoot(tabId, opts)), { signal: wait.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function shoot(tabId: number, opts: { full?: boolean; ref?: string }): Promise<ScreenshotResult> {
  if (opts.ref !== undefined && !REF_RE.test(opts.ref)) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `params.ref must look like @e12abc, got ${opts.ref}`)
  }
  await ensureAttached(tabId)
  const params: Record<string, unknown> = { format: "png" }
  if (opts.ref !== undefined) {
    const r = await callAgent<{ x: number; y: number; width: number; height: number } | null>(tabId, "rect", [opts.ref])
    if (!r) throw new RpcError(ErrorCode.BAD_REQUEST, `${opts.ref} is not on the page or not visible (run: kite snapshot)`)
    params.clip = { ...r, scale: 1 }
    params.captureBeyondViewport = true
  } else if (opts.full) {
    const m = await send<{ cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number } }>(
      tabId,
      "Page.getLayoutMetrics",
    )
    const size = m.cssContentSize ?? m.contentSize
    // The clip is in CSS px but the texture limit is in device px.
    let dpr = 1
    try {
      const r = await send<{ result: { value?: unknown } }>(tabId, "Runtime.evaluate", { expression: "window.devicePixelRatio", returnByValue: true })
      if (typeof r.result.value === "number" && r.result.value > 0) dpr = r.result.value
    } catch {} // keep 1: the page may be mid-navigation
    const maxCss = Math.floor(MAX_FULL_HEIGHT / dpr)
    params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), maxCss), scale: 1 }
    params.captureBeyondViewport = true
  }
  const { data } = await send<{ data: string }>(tabId, "Page.captureScreenshot", params, SCREENSHOT_TIMEOUT_MS)
  return { mime: "image/png", data, ...pngSize(data) }
}
