import net from "node:net"
import type { Method } from "@bx/protocol"
import { RpcResponse } from "@bx/protocol"
import { socketPath } from "../paths.js"

export class BxError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = "BxError"
  }
}

const NOT_CONNECTED_MSG = "browser not connected (is Chrome open with the bx extension?)"
const CONNECT_TIMEOUT_MS = 2000

export function call(
  method: Method,
  params: object,
  opts: { session: string; timeoutMs?: number },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath())
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
      () => finish(() => reject(new BxError("NOT_CONNECTED", NOT_CONNECTED_MSG))),
      CONNECT_TIMEOUT_MS,
    )
    sock.setEncoding("utf8")
    sock.on("connect", () => {
      connected = true
      clearTimeout(timer)
      if (opts.timeoutMs) {
        timer = setTimeout(
          () => finish(() => reject(new BxError("TIMEOUT", `no response after ${opts.timeoutMs}ms`))),
          opts.timeoutMs,
        )
      } else timer = undefined
      sock.write(JSON.stringify({ id: 1, method, params, session: opts.session }) + "\n")
    })
    sock.on("error", (e: NodeJS.ErrnoException) => {
      if (!connected) finish(() => reject(new BxError("NOT_CONNECTED", NOT_CONNECTED_MSG)))
      else finish(() => reject(new BxError("INTERNAL", e.message)))
    })
    sock.on("close", () => {
      finish(() => reject(new BxError(connected ? "INTERNAL" : "NOT_CONNECTED", connected ? "connection closed before response" : NOT_CONNECTED_MSG)))
    })
    sock.on("data", (chunk: string) => {
      buf += chunk
      const i = buf.indexOf("\n")
      if (i < 0) return
      let msg: unknown
      try {
        msg = JSON.parse(buf.slice(0, i))
      } catch {
        return finish(() => reject(new BxError("INTERNAL", "invalid response from host")))
      }
      const parsed = RpcResponse.safeParse(msg)
      if (!parsed.success) return finish(() => reject(new BxError("INTERNAL", "malformed response from host")))
      const r = parsed.data
      if ("error" in r) finish(() => reject(new BxError(r.error.code, r.error.message)))
      else finish(() => resolve(r.result))
    })
  })
}
