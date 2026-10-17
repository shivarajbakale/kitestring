import { ANALYTICS_HOST_RE, IGNORED_RESOURCE_TYPES } from "@bx/protocol"

const IGNORED_TYPES: ReadonlySet<string> = new Set(IGNORED_RESOURCE_TYPES)

/**
 * In-flight request bookkeeping, fed with CDP events (pure: no chrome.* access).
 * Counts Network.requestWillBeSent minus loadingFinished/loadingFailed.
 */
export class InflightRequests {
  /** requestId → loaderId of the document that issued it. */
  private inflight = new Map<string, string>()
  /** When the count last dropped to zero. */
  quietSince: number

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
      this.inflight.set(params.requestId as string, (params.loaderId as string | undefined) ?? "")
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      if (this.inflight.delete(params.requestId as string) && this.inflight.size === 0) this.quietSince = now
    } else if (method === "Page.frameNavigated") {
      // A main-frame commit discards the old document: its pending requests may never report
      // loadingFinished/loadingFailed, so forget everything not issued by the new document.
      const frame = params.frame as { parentId?: string; loaderId?: string } | undefined
      if (!frame || frame.parentId) return
      const before = this.inflight.size
      for (const [id, loaderId] of this.inflight) if (loaderId !== frame.loaderId) this.inflight.delete(id)
      if (before > 0 && this.inflight.size === 0) this.quietSince = now
    }
  }
}
