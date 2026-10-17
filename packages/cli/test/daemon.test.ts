import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startDaemon, type Daemon } from "../src/host/daemon.js"

let dir: string
let sock: string
const daemons: Daemon[] = []
const clients: net.Socket[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bxd-"))
  sock = join(dir, "bx.sock")
})
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy()
  for (const d of daemons.splice(0)) await d.close()
  rmSync(dir, { recursive: true, force: true })
})

function client(): Promise<{ send: (m: unknown) => void; next: () => Promise<any> }> {
  return new Promise((resolve) => {
    const s = net.connect(sock)
    clients.push(s)
    let buf = ""
    const queue: any[] = []
    const waiters: ((v: any) => void)[] = []
    s.on("data", (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        const msg = JSON.parse(line)
        const w = waiters.shift()
        if (w) w(msg)
        else queue.push(msg)
      }
    })
    s.on("connect", () =>
      resolve({
        send: (m) => s.write(JSON.stringify(m) + "\n"),
        next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
      }),
    )
  })
}

async function start(toExtension: (m: unknown) => void = () => {}) {
  const d = await startDaemon({ socketPath: sock, toExtension })
  daemons.push(d)
  return d
}

const req = (id: number) => ({ id, method: "status", params: {}, session: "s" })

describe("daemon", () => {
  it("routes request to extension and response back to the right client", async () => {
    const seen: any[] = []
    const d = await start((m) => seen.push(m))
    const a = await client()
    const b = await client()
    a.send(req(1))
    b.send(req(1))
    await vi_waitFor(() => seen.length === 2)
    expect(seen[0].id).not.toBe(seen[1].id)
    // reply out of order
    d.fromExtension({ id: seen[1].id, result: "for-b" })
    d.fromExtension({ id: seen[0].id, result: "for-a" })
    expect(await a.next()).toEqual({ id: 1, result: "for-a" })
    expect(await b.next()).toEqual({ id: 1, result: "for-b" })
  })

  it("fails pending requests with NOT_CONNECTED when extension disconnects", async () => {
    const seen: any[] = []
    const d = await start((m) => seen.push(m))
    const a = await client()
    a.send(req(7))
    await vi_waitFor(() => seen.length === 1)
    d.fromExtension({ type: "disconnected" })
    const r = await a.next()
    expect(r.id).toBe(7)
    expect(r.error.code).toBe("NOT_CONNECTED")
  })

  it("responds BAD_REQUEST to an invalid request", async () => {
    await start()
    const a = await client()
    a.send({ id: 3, method: "nope" })
    const r = await a.next()
    expect(r.id).toBe(3)
    expect(r.error.code).toBe("BAD_REQUEST")
  })

  it("socket file has mode 0600", async () => {
    await start()
    expect(statSync(sock).mode & 0o777).toBe(0o600)
  })

  it("unlinks stale socket", async () => {
    writeFileSync(sock, "")
    await start()
    const a = await client()
    expect(a).toBeTruthy()
  })

  it("starts over a dead socket left by a killed process (ECONNREFUSED)", async () => {
    const child = spawn(
      process.execPath,
      ["-e", `require("net").createServer().listen(${JSON.stringify(sock)},()=>console.log("up"))`],
      { stdio: ["ignore", "pipe", "inherit"] },
    )
    await new Promise<void>((r) => child.stdout.once("data", () => r()))
    child.kill("SIGKILL")
    await new Promise((r) => child.once("exit", r))
    expect(statSync(sock).isSocket()).toBe(true)
    await start()
    const a = await client()
    expect(a).toBeTruthy()
  })

  it("logs and ignores unrecognized extension messages", async () => {
    const logs: string[] = []
    const d = await startDaemon({ socketPath: sock, toExtension: () => {}, log: (m) => logs.push(m) })
    daemons.push(d)
    d.fromExtension({ type: "weird" })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("weird")
  })

  it("refuses to start when a live daemon owns the socket", async () => {
    await start()
    await expect(startDaemon({ socketPath: sock, toExtension: () => {} })).rejects.toThrow(/already running/)
  })
})

async function vi_waitFor(cond: () => boolean) {
  const t = Date.now()
  while (!cond()) {
    if (Date.now() - t > 2000) throw new Error("timeout")
    await new Promise((r) => setTimeout(r, 5))
  }
}
