import { HOST_NAME } from "@bx/protocol"

const BACKOFF_MS = [1000, 2000, 5000]
const STEADY_MS = 10_000

export interface HostConnection {
  send(m: unknown): void
}

/**
 * Connects to the native host and keeps reconnecting (1 s, 2 s, 5 s, then every 10 s).
 * An open native port keeps the MV3 service worker alive.
 */
export function connectHost(onMessage: (m: unknown) => void): HostConnection {
  let port: chrome.runtime.Port | null = null
  let attempt = 0

  const connect = () => {
    const p = chrome.runtime.connectNative(HOST_NAME)
    port = p
    p.onMessage.addListener((m: unknown) => {
      attempt = 0
      onMessage(m)
    })
    p.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message
      if (port === p) port = null
      const delay = BACKOFF_MS[attempt] ?? STEADY_MS
      attempt++
      console.warn(`[bx] native host disconnected${err ? `: ${err}` : ""}; retrying in ${delay} ms`)
      setTimeout(connect, delay)
    })
  }
  connect()

  return {
    send(m) {
      if (!port) {
        console.warn("[bx] dropping message: native host not connected")
        return
      }
      port.postMessage(m)
    },
  }
}
