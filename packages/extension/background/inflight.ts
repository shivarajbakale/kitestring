import { ANALYTICS_HOST_RE, IGNORED_RESOURCE_TYPES, STALE_REQUEST_MS } from "@kitestring/protocol"

const IGNORED_TYPES: ReadonlySet<string> = new Set(IGNORED_RESOURCE_TYPES)

/**
 * In-flight request bookkeeping, fed with CDP events (pure: no chrome.* access).
 * Counts Network.requestWillBeSent minus loadingFinished/loadingFailed; `prune` drops requests in flight longer than
 * STALE_REQUEST_MS (long polls; worker requests whose end the page target never sees).
 */
export class InflightRequests {
  /** requestId → loaderId of the document that issued it, and when it was sent. */
  private inflight = new Map<string, { loaderId: string; at: number }>()
  /** When the count last dropped to zero. */
  quietSince: number
  /** Counted requests sent so far (a click that starts one had an effect). */
  sent = 0

  constructor(now = Date.now()) {
    this.quietSince = now
  }

  get size(): number {
    return this.inflight.size
  }

  onEvent(method: string, params: Record<string, unknown>, now = Date.now()): void {
    if (method === "Network.requestWillBeSent") {
      const type = params.type as string | undefined
      const url = (params.request as { url?: string } | undefined)?.url ?? ""
      if ((type && IGNORED_TYPES.has(type)) || ANALYTICS_HOST_RE.test(url)) return
      // Redirects reuse the id: a map keeps it idempotent.
      const id = params.requestId as string
      if (!this.inflight.has(id)) this.sent++
      this.inflight.set(id, { loaderId: (params.loaderId as string | undefined) ?? "", at: this.inflight.get(id)?.at ?? now })
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      if (this.inflight.delete(params.requestId as string) && this.inflight.size === 0) this.quietSince = now
    } else if (method === "Page.frameNavigated") {
      // A main-frame commit discards the old document: its pending requests may never report
      // loadingFinished/loadingFailed, so forget everything not issued by the new document.
      const frame = params.frame as { parentId?: string; loaderId?: string } | undefined
      if (!frame || frame.parentId) return
      const before = this.inflight.size
      for (const [id, r] of this.inflight) if (r.loaderId !== frame.loaderId) this.inflight.delete(id)
      if (before > 0 && this.inflight.size === 0) this.quietSince = now
    }
  }

  /** Forgets requests sent STALE_REQUEST_MS or more before `now`; the last one going starts the quiet period. */
  prune(now = Date.now()): void {
    const before = this.inflight.size
    for (const [id, r] of this.inflight) if (now - r.at >= STALE_REQUEST_MS) this.inflight.delete(id)
    if (before > 0 && this.inflight.size === 0) this.quietSince = now
  }
}
