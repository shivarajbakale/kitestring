import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXTENSION_ID, type ActionResult } from "@kitestring/protocol"
import { startDaemon, type Daemon } from "../src/host/daemon.js"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js")
let dir: string
let daemon: Daemon | undefined
let received: any[]
let canned: ActionResult
/** When set, the fake extension answers with this instead of a result (or never answers, for "silent"). */
let reply: { error: { code: string; message: string } } | "silent" | undefined

const done: ActionResult = { ok: true, status: "done", diff: { added: ["button Saved"], removed: [] }, page: "Page" }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kitecli-"))
  received = []
  canned = done
  reply = undefined
  daemon = undefined
})
afterEach(async () => {
  await daemon?.close()
  rmSync(dir, { recursive: true, force: true })
})

async function startFake(): Promise<void> {
  const d: Daemon = await startDaemon({
    socketPath: join(dir, "kite.sock"),
    toExtension: (msg: any) => {
      received.push(msg)
      if (reply === "silent") return
      const r = reply
      queueMicrotask(() =>
        d.fromExtension(
          r ? { id: msg.id, ...r } : { id: msg.id, result: msg.method === "page.snapshot" ? { text: "snap text" } : canned },
        ),
      )
    },
  })
  daemon = d
}

function kite(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, KITE_SESSION: "", KITE_HOME: dir, ...env } })
    let out = ""
    let err = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (err += d))
    p.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }))
  })
}

describe("kite cli", () => {
  it("click text target", async () => {
    await startFake()
    const r = await kite(["click", "Save"])
    expect(r.out.startsWith("✓ done")).toBe(true)
    expect(r.code).toBe(0)
    expect(received[0].method).toBe("act.click")
    expect(received[0].params.target).toEqual({ text: "Save" })
    expect(received[0].session).toBe("default")
  })
  it("KITE_SESSION and ref target", async () => {
    await startFake()
    await kite(["click", "@e1k2d9"], { KITE_SESSION: "agent2" })
    expect(received[0].session).toBe("agent2")
    expect(received[0].params.target).toEqual({ ref: "@e1k2d9" })
  })
  it("--json prints raw result", async () => {
    await startFake()
    const r = await kite(["click", "Save", "--json"])
    expect(JSON.parse(r.out)).toEqual(canned)
  })
  it("not_found exits 1", async () => {
    canned = { ok: false, status: "not_found", detail: "nope", diff: { added: [], removed: [] }, page: "P" }
    await startFake()
    const r = await kite(["click", "Nope"])
    expect(r.code).toBe(1)
    expect(r.out.startsWith("✗ not_found: nope")).toBe(true)
  })
  it("snapshot prints text", async () => {
    await startFake()
    const r = await kite(["snapshot", "--full"])
    expect(r.out.trim()).toBe("snap text")
    expect(received[0].params.full).toBe(true)
  })
  it("no daemon: exit 2 quickly", async () => {
    const r = await kite(["click", "Save"])
    expect(r.err).toBe("kite: browser not connected (is Chrome open with the Kitestring extension?)\n")
    expect(r.code).toBe(2)
    expect(r.ms).toBeLessThan(2500)
  })
  it("install-host defaults --extension-id to EXTENSION_ID", async () => {
    const r = await kite(["install-host", "--browser", "chromium", "--user-data-dir", dir])
    expect(r.code).toBe(0)
    const m = JSON.parse(readFileSync(join(dir, "NativeMessagingHosts", "com.kitestring.bridge.json"), "utf8"))
    expect(m.allowed_origins).toEqual([`chrome-extension://${EXTENSION_ID}/`])
  })

  it("extension never answers: TIMEOUT exit 1 within the bound", async () => {
    reply = "silent"
    await startFake()
    const r = await kite(["snapshot"], { KITE_TIMEOUT_MS: "500" })
    expect(r.err).toBe("kite: timed out waiting for the browser\n")
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(2500)
  })
  it("RESTRICTED prints the extension message verbatim", async () => {
    reply = { error: { code: "RESTRICTED", message: "restricted page (data:text/html,<h1>hi</h1>) — browser blocks extensions here" } }
    await startFake()
    const r = await kite(["snapshot"])
    expect(r.err).toBe("kite: restricted page (data:text/html,<h1>hi</h1>) — browser blocks extensions here\n")
    expect(r.code).toBe(1)
  })
  it("RESTRICTED on about:blank adds a hint", async () => {
    reply = { error: { code: "RESTRICTED", message: "restricted page (about:blank) — browser blocks extensions here" } }
    await startFake()
    const r = await kite(["snapshot"])
    expect(r.err).toBe(
      "kite: restricted page (about:blank) — browser blocks extensions here (blank tab — run kite goto <url>)\n",
    )
    expect(r.code).toBe(1)
  })
  it("--json with an RPC error prints the error JSON to stdout too", async () => {
    reply = { error: { code: "NO_TAB", message: "NO_TAB: session has no active tab" } }
    await startFake()
    const r = await kite(["snapshot", "--json"])
    expect(JSON.parse(r.out)).toEqual({ error: { code: "NO_TAB", message: "NO_TAB: session has no active tab" } })
    expect(r.err).toBe("kite: NO_TAB: session has no active tab\n")
    expect(r.code).toBe(1)
  })
  it.each(["0", "-5", "1.5", "abc", "1e3x"])("scroll px %s is a usage error", async (px) => {
    await startFake()
    const r = await kite(["scroll", "down", px])
    expect(r.code).toBe(2)
    expect(r.err).toContain("px must be a positive integer")
    expect(received).toHaveLength(0)
  })
  it("scroll px positive integer is sent", async () => {
    await startFake()
    const r = await kite(["scroll", "down", "250"])
    expect(r.code).toBe(0)
    expect(received[0].params).toEqual({ direction: "down", px: 250 })
  })
  it("upload sends absolute real paths and prints the uploaded names", async () => {
    await startFake()
    // Not under KITE_HOME (dir), which is itself a denied location.
    const files = mkdtempSync(join(tmpdir(), "kitefiles-"))
    try {
      const zip = join(files, "a.zip")
      writeFileSync(zip, "x")
      const want = realpathSync(files) + "/a.zip"
      canned = { ...done, uploaded: ["a.zip"] }
      const r = await kite(["upload", "Extension zip", zip])
      expect(r.code).toBe(0)
      expect(received[0].method).toBe("act.upload")
      expect(received[0].params).toEqual({ target: { text: "Extension zip" }, files: [want] })
      expect(r.out).toContain("↑ uploaded a.zip")
    } finally {
      rmSync(files, { recursive: true, force: true })
    }
  })
  it("upload from a sensitive location is refused before any RPC", async () => {
    await startFake()
    mkdirSync(join(dir, ".ssh"))
    writeFileSync(join(dir, ".ssh", "x"), "k")
    const r = await kite(["upload", "Extension zip", join(dir, ".ssh", "x")], { HOME: dir })
    expect(r.code).toBe(1)
    expect(r.err).toContain("refusing to upload")
    expect(r.err).toContain("sensitive location")
    expect(received).toHaveLength(0)
  })
})
