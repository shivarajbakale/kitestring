import net from "node:net"
import type { Method } from "@kitestring/protocol"
import { RpcResponse } from "@kitestring/protocol"
import { socketPath } from "../paths.js"

export class KiteError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = "KiteError"
  }
}

const NOT_CONNECTED_MSG = "browser not connected (is Chrome open with the Kitestring extension?)"
const CONNECT_TIMEOUT_MS = 2000
/**
 * Post-connect bound on a call. Above the extension's own bounds (page agent 30 s, action cap 15 s,
 * snapshot 15 s), so it only fires when the browser side is truly stuck. `KITE_TIMEOUT_MS` overrides it.
 */
export const DEFAULT_TIMEOUT_MS = 60_000
export const TIMEOUT_MSG = "timed out waiting for the browser"

function defaultTimeout(): number {
  const n = Number(process.env.KITE_TIMEOUT_MS)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS
}

export function call(
  method: Method,
  params: object,
  opts: { session: string; timeoutMs?: number; socketPath?: string },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(opts.socketPath ?? socketPath())
    let settled = false
    let connected = false
    let buf = ""
    let timer: NodeJS.Timeout | undefined
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      sock.destroy()
      fn()
    }
    timer = setTimeout(
      () => finish(() => reject(new KiteError("NOT_CONNECTED", NOT_CONNECTED_MSG))),
      CONNECT_TIMEOUT_MS,
    )
    sock.setEncoding("utf8")
    sock.on("connect", () => {
      connected = true
      clearTimeout(timer)
      timer = setTimeout(
        () => finish(() => reject(new KiteError("TIMEOUT", TIMEOUT_MSG))),
        opts.timeoutMs ?? defaultTimeout(),
      )
      sock.write(JSON.stringify({ id: 1, method, params, session: opts.session }) + "\n")
    })
    sock.on("error", (e: NodeJS.ErrnoException) => {
      if (!connected) finish(() => reject(new KiteError("NOT_CONNECTED", NOT_CONNECTED_MSG)))
      else finish(() => reject(new KiteError("INTERNAL", e.message)))
    })
    sock.on("close", () => {
      finish(() => reject(new KiteError(connected ? "INTERNAL" : "NOT_CONNECTED", connected ? "connection closed before response" : NOT_CONNECTED_MSG)))
    })
    sock.on("data", (chunk: string) => {
      buf += chunk
      const i = buf.indexOf("\n")
      if (i < 0) return
      let msg: unknown
      try {
        msg = JSON.parse(buf.slice(0, i))
      } catch {
        return finish(() => reject(new KiteError("INTERNAL", "invalid response from host")))
      }
      const parsed = RpcResponse.safeParse(msg)
      if (!parsed.success) return finish(() => reject(new KiteError("INTERNAL", "malformed response from host")))
      const r = parsed.data
      if ("error" in r) finish(() => reject(new KiteError(r.error.code, r.error.message)))
      else finish(() => resolve(r.result))
    })
  })
}
