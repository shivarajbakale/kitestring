import { chmod, unlink } from "node:fs/promises"
import net from "node:net"
import { RpcRequest, RpcResponse } from "@kitestring/protocol"
import { FrameTooLargeError } from "./framing.js"

export interface Daemon {
  fromExtension(msg: unknown): void
  close(): Promise<void>
}

export interface DaemonOptions {
  socketPath: string
  toExtension: (msg: unknown) => void
  log?: (msg: string) => void
}

interface Pending {
  socket: net.Socket
  originalId: number
}

function probe(path: string, timeoutMs = 1000): Promise<"live" | "stale"> {
  return new Promise((resolve, reject) => {
    const s = net.connect(path)
    const timer = setTimeout(() => {
      s.destroy()
      resolve("live") // unresponsive: assume something owns it
    }, timeoutMs)
    s.once("connect", () => {
      clearTimeout(timer)
      s.destroy()
      resolve("live")
    })
    s.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      s.destroy()
      if (e.code === "ECONNREFUSED" || e.code === "ENOENT" || e.code === "ENOTSOCK") resolve("stale")
      else reject(e)
    })
  })
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  if ((await probe(opts.socketPath)) === "live") {
    throw new Error(`kitestring host already running (socket ${opts.socketPath} is in use)`)
  }
  await unlink(opts.socketPath).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e
  })

  const pending = new Map<number, Pending>()
  const sockets = new Set<net.Socket>()
  let nextId = 1

  const reply = (socket: net.Socket, res: RpcResponse) => {
    if (!socket.destroyed) socket.write(JSON.stringify(res) + "\n")
  }

  const handleLine = (socket: net.Socket, line: string) => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return reply(socket, { id: 0, error: { code: "BAD_REQUEST", message: "invalid JSON" } })
    }
    const parsed = RpcRequest.safeParse(raw)
    if (!parsed.success) {
      const rawId = (raw as { id?: unknown } | null)?.id
      const id = typeof rawId === "number" ? rawId : 0
      return reply(socket, { id, error: { code: "BAD_REQUEST", message: parsed.error.message } })
    }
    const req = parsed.data
    const daemonId = nextId++
    pending.set(daemonId, { socket, originalId: req.id })
    try {
      opts.toExtension({ ...req, id: daemonId })
    } catch (e) {
      pending.delete(daemonId)
      const message = e instanceof Error ? e.message : String(e)
      const code = e instanceof FrameTooLargeError ? "BAD_REQUEST" : "INTERNAL"
      reply(socket, { id: req.id, error: { code, message } })
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket)
    let buf = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buf += chunk
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) handleLine(socket, line)
      }
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      sockets.delete(socket)
      for (const [id, p] of pending) if (p.socket === socket) pending.delete(id)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
  await chmod(opts.socketPath, 0o600)

  return {
    fromExtension(msg) {
      if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "disconnected") {
        for (const p of pending.values()) {
          reply(p.socket, {
            id: p.originalId,
            error: { code: "NOT_CONNECTED", message: "browser not connected" },
          })
        }
        pending.clear()
        return
      }
      const parsed = RpcResponse.safeParse(msg)
      if (!parsed.success) {
        opts.log?.(`ignored unrecognized message from extension: ${JSON.stringify(msg)?.slice(0, 200)}`)
        return
      }
      const p = pending.get(parsed.data.id)
      if (!p) return
      pending.delete(parsed.data.id)
      reply(p.socket, { ...parsed.data, id: p.originalId } as RpcResponse)
    },
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(opts.socketPath).catch(() => {})
    },
  }
}
