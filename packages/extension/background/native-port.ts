import { HOST_NAME } from "@kitestring/protocol"

const BACKOFF_MS = [1000, 2000, 5000]
const STEADY_MS = 10_000

/** A port that hasn't disconnected after this long reached a running host (a missing host fails at once). */
const SETTLE_MS = 500

export interface HostConnection {
  send(m: unknown): void
}

let hostUp = false

/** True while the native host is running and connected (read by the popup and side panel). */
export function isHostConnected(): boolean {
  return hostUp
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
    const settled = setTimeout(() => {
      if (port === p) hostUp = true
    }, SETTLE_MS)
    p.onMessage.addListener((m: unknown) => {
      attempt = 0
      if (port === p) hostUp = true
      onMessage(m)
    })
    p.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message
      clearTimeout(settled)
      if (port === p) {
        port = null
        hostUp = false
      }
      const delay = BACKOFF_MS[attempt] ?? STEADY_MS
      attempt++
      console.warn(`[kite] native host disconnected${err ? `: ${err}` : ""}; retrying in ${delay} ms`)
      setTimeout(connect, delay)
    })
  }
  connect()

  return {
    send(m) {
      if (!port) {
        console.warn("[kite] dropping message: native host not connected")
        return
      }
      port.postMessage(m)
    },
  }
}
