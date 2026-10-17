import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ActionResult } from "@bx/protocol"
import { startDaemon, type Daemon } from "../src/host/daemon.js"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js")
let dir: string
let daemon: Daemon | undefined
let received: any[]
let canned: ActionResult

const done: ActionResult = { ok: true, status: "done", diff: { added: ["button Saved"], removed: [] }, page: "Page" }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bxcli-"))
  received = []
  canned = done
  daemon = undefined
})
afterEach(async () => {
  await daemon?.close()
  rmSync(dir, { recursive: true, force: true })
})

async function startFake(): Promise<void> {
  const d: Daemon = await startDaemon({
    socketPath: join(dir, "bx.sock"),
    toExtension: (msg: any) => {
      received.push(msg)
      queueMicrotask(() => d.fromExtension({ id: msg.id, result: msg.method === "page.snapshot" ? { text: "snap text" } : canned }))
    },
  })
  daemon = d
}

function bx(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, BX_SESSION: "", BX_HOME: dir, ...env } })
    let out = ""
    let err = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (err += d))
    p.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }))
  })
}

describe("bx cli", () => {
  it("click text target", async () => {
    await startFake()
    const r = await bx(["click", "Save"])
    expect(r.out.startsWith("✓ done")).toBe(true)
    expect(r.code).toBe(0)
    expect(received[0].method).toBe("act.click")
    expect(received[0].params.target).toEqual({ text: "Save" })
    expect(received[0].session).toBe("default")
  })
  it("BX_SESSION and ref target", async () => {
    await startFake()
    await bx(["click", "@e1k2d9"], { BX_SESSION: "agent2" })
    expect(received[0].session).toBe("agent2")
    expect(received[0].params.target).toEqual({ ref: "@e1k2d9" })
  })
  it("--json prints raw result", async () => {
    await startFake()
    const r = await bx(["click", "Save", "--json"])
    expect(JSON.parse(r.out)).toEqual(canned)
  })
  it("not_found exits 1", async () => {
    canned = { ok: false, status: "not_found", detail: "nope", diff: { added: [], removed: [] }, page: "P" }
    await startFake()
    const r = await bx(["click", "Nope"])
    expect(r.code).toBe(1)
    expect(r.out.startsWith("✗ not_found: nope")).toBe(true)
  })
  it("snapshot prints text", async () => {
    await startFake()
    const r = await bx(["snapshot", "--full"])
    expect(r.out.trim()).toBe("snap text")
    expect(received[0].params.full).toBe(true)
  })
  it("no daemon: exit 2 quickly", async () => {
    const r = await bx(["click", "Save"])
    expect(r.err).toBe("bx: browser not connected (is Chrome open with the bx extension?)\n")
    expect(r.code).toBe(2)
    expect(r.ms).toBeLessThan(2500)
  })
  it("install-host without extension id is a usage error", async () => {
    const r = await bx(["install-host", "--user-data-dir", dir])
    expect(r.code).toBe(2)
  })
})
