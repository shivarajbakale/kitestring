import { onEvent } from "./cdp"
import { InflightRequests } from "./inflight"

export interface NetworkTracker {
  /** Resolves true once no counted request has been in flight for `quietMs`, false at `timeoutMs`. */
  waitIdle(quietMs: number, timeoutMs: number): Promise<boolean>
  /** Requests sent since tracking started (analytics and streams not counted). */
  sent(): number
  stop(): void
}

/** Counts in-flight requests of the tab (see InflightRequests). */
export function trackNetwork(tabId: number): NetworkTracker {
  const inflight = new InflightRequests()
  const off = onEvent(tabId, ({ method, params }) => inflight.onEvent(method, params))

  return {
    waitIdle: (quietMs, timeoutMs) =>
      new Promise((resolve) => {
        const start = Date.now()
        const tick = () => {
          const now = Date.now()
          inflight.prune(now)
          if (inflight.size === 0 && now - inflight.quietSince >= quietMs) return finish(true)
          if (now - start >= timeoutMs) return finish(false)
        }
        const finish = (idle: boolean) => {
          clearInterval(timer)
          resolve(idle)
        }
        const timer = setInterval(tick, 50)
        tick()
      }),
    sent: () => inflight.sent,
    stop: off,
  }
}
