import { ANALYTICS_HOST_RE, IGNORED_RESOURCE_TYPES } from "@bx/protocol"
import { onEvent } from "./cdp"

export interface NetworkTracker {
  /** Resolves true once no counted request has been in flight for `quietMs`, false at `timeoutMs`. */
  waitIdle(quietMs: number, timeoutMs: number): Promise<boolean>
  stop(): void
}

const IGNORED_TYPES: ReadonlySet<string> = new Set(IGNORED_RESOURCE_TYPES)

/** Counts in-flight requests (Network.requestWillBeSent minus loadingFinished/loadingFailed). */
export function trackNetwork(tabId: number): NetworkTracker {
  const inflight = new Set<string>()
  let quietSince = Date.now()

  const off = onEvent(tabId, ({ method, params }) => {
    if (method === "Network.requestWillBeSent") {
      const type = params.type as string | undefined
      const url = (params.request as { url?: string } | undefined)?.url ?? ""
      if ((type && IGNORED_TYPES.has(type)) || ANALYTICS_HOST_RE.test(url)) return
      inflight.add(params.requestId as string) // redirects reuse the id: a set keeps it idempotent
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      if (inflight.delete(params.requestId as string) && inflight.size === 0) quietSince = Date.now()
    }
  })

  return {
    waitIdle: (quietMs, timeoutMs) =>
      new Promise((resolve) => {
        const start = Date.now()
        const tick = () => {
          const now = Date.now()
          if (inflight.size === 0 && now - quietSince >= quietMs) return finish(true)
          if (now - start >= timeoutMs) return finish(false)
        }
        const finish = (idle: boolean) => {
          clearInterval(timer)
          resolve(idle)
        }
        const timer = setInterval(tick, 50)
        tick()
      }),
    stop: off,
  }
}
