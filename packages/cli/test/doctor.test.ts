import { spawn } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startDaemon, type Daemon } from "../src/host/daemon.js"
import { runInit } from "../src/init/init.js"
import { hostsDir } from "../src/install/host-manifest.js"
import { runDoctor, formatChecks, type Check } from "../src/doctor/doctor.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, "fixtures", "homes")
const BIN = join(HERE, "..", "dist", "bin.js")

let tmp: string
let home: string
let kh: string
let emptyBin: string
let daemon: Daemon | undefined

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "kitedoc-")))
  emptyBin = join(tmp, "emptybin")
  mkdirSync(emptyBin)
  home = join(tmp, "home")
  kh = join(tmp, "kh")
  daemon = undefined
})
afterEach(async () => {
  await daemon?.close()
  rmSync(tmp, { recursive: true, force: true })
})

const useFixture = (name: string) => cpSync(join(FIXTURES, name), home, { recursive: true })
const env = () => ({ PATH: emptyBin, KITE_HOME: kh })
const doctor = (extra = {}) => {
  // SAFETY: home is under the temp dir.
  expect(home.startsWith(tmp + sep)).toBe(true)
  return runDoctor({ home, env: env(), ...extra })
}
const by = (cs: Check[], id: string) => cs.find((c) => c.id === id)!

async function startFake(connected = true): Promise<void> {
  mkdirSync(kh, { recursive: true })
  const d: Daemon = await startDaemon({
    socketPath: join(kh, "kite.sock"),
    toExtension: (msg: any) => queueMicrotask(() => d.fromExtension({ id: msg.id, result: { connected, sessions: [], paused: false } })),
  })
  daemon = d
}

const init = async () => {
  const lines: string[] = []
  const code = await runInit({ home, env: env(), yes: true, out: (s) => lines.push(s), isConnected: async () => false })
  expect(code, lines.join("\n")).toBe(0)
}

describe("kite doctor", () => {
  it("fresh home with agents: host, extension and agent checks fail with specific fixes", async () => {
    useFixture("full")
    const cs = await doctor()
    expect(by(cs, "node").ok).toBe(true)
    expect(by(cs, "host-manifest")).toMatchObject({ ok: false, fix: expect.stringContaining("kite install-host") })
    expect(by(cs, "host-wrapper").ok).toBe(false)
    expect(by(cs, "bridge")).toMatchObject({ ok: false, fix: expect.stringMatching(/never started.*load or reload the Kitestring extension.*chrome:\/\/extensions/s) })
    expect(by(cs, "extension").ok).toBe(false)
    for (const a of ["claude-code", "codex", "cursor", "gemini", "opencode"]) {
      expect(by(cs, `mcp:${a}`), a).toMatchObject({ ok: false, fix: expect.stringContaining("kite init") })
      expect(by(cs, `skills:${a}`), a).toMatchObject({ ok: false, fix: expect.stringContaining("kite init") })
    }
    expect(formatChecks(cs)).toMatch(/✗ bridge[\s\S]*fix: /)
  })

  it("only checks agents that are installed, and writes nothing", async () => {
    useFixture("partial")
    const snap = () => JSON.stringify(readdirSync(home, { recursive: true }).sort())
    const before = snap()
    const cs = await doctor()
    expect(cs.map((c) => c.id).filter((i) => i.includes(":"))).toEqual(["mcp:cursor", "skills:cursor"])
    expect(snap()).toBe(before)
    expect(existsSync(kh)).toBe(false)
  })

  it("after kite init with a live bridge and extension everything passes", async () => {
    useFixture("full")
    await init()
    await startFake()
    const cs = await doctor()
    expect(cs.filter((c) => !c.ok)).toEqual([])
    expect(cs.map((c) => c.id)).toEqual([
      "node", "host-manifest", "host-wrapper", "bridge", "extension",
      "mcp:claude-code", "skills:claude-code", "mcp:codex", "skills:codex", "mcp:cursor", "skills:cursor",
      "mcp:gemini", "skills:gemini", "mcp:opencode", "skills:opencode",
    ])
  })

  it("bridge: stale socket vs connected-but-extension-not-connected", async () => {
    useFixture("full")
    await init()
    // A leftover socket file nobody listens on
    const net = await import("node:net")
    mkdirSync(kh, { recursive: true })
    const srv = net.createServer().listen(join(kh, "kite.sock"))
    await new Promise((r) => srv.once("listening", r))
    await new Promise((r) => srv.close(r))
    writeFileSync(join(kh, "kite.sock"), "") // plain file, connect fails
    let cs = await doctor()
    expect(by(cs, "bridge")).toMatchObject({ ok: false, fix: expect.stringContaining("stale") })
    rmSync(join(kh, "kite.sock"))
    await startFake(false)
    cs = await doctor()
    expect(by(cs, "bridge").ok).toBe(true)
    expect(by(cs, "extension").ok).toBe(false)
  })

  it("a live daemon answering NOT_CONNECTED is bridge ok, extension not connected (not stale)", async () => {
    useFixture("partial")
    mkdirSync(kh, { recursive: true })
    const d: Daemon = await startDaemon({
      socketPath: join(kh, "kite.sock"),
      toExtension: (msg: any) => queueMicrotask(() => d.fromExtension({ id: msg.id, error: { code: "NOT_CONNECTED", message: "browser not connected" } })),
    })
    daemon = d
    const cs = await doctor()
    expect(by(cs, "bridge").ok).toBe(true)
    expect(by(cs, "extension")).toMatchObject({ ok: false, detail: expect.stringContaining("not connected"), fix: expect.stringContaining("extension") })
  })

  it("claude-code via the claude CLI on PATH: ok when bin exists, fails when claude has no server", async () => {
    useFixture("full")
    const fb = join(tmp, "fakebin")
    mkdirSync(fb)
    const state = join(tmp, "claude-state")
    writeFileSync(join(fb, "claude"), `#!/bin/sh\nPATH=/usr/bin:/bin\nif [ "$1 $2" = "mcp get" ]; then\n  [ -f '${state}' ] || { echo "No MCP server found with name: $3" >&2; exit 1; }\n  cat '${state}'; exit 0\nfi\nexit 3\n`)
    chmodSync(join(fb, "claude"), 0o755)
    const run = () => runDoctor({ home, env: { PATH: fb, KITE_HOME: kh } })
    expect(by(await run(), "mcp:claude-code")).toMatchObject({ ok: false, fix: expect.stringContaining("kite init") })
    writeFileSync(state, `kitestring:\n  Scope: User config (available in all your projects)\n  Status: ✓ Connected\n  Type: stdio\n  Command: /opt/x/node\n  Args: ${BIN} mcp\n  Environment:\n    KITE_SESSION=claude-code\n`)
    expect(by(await run(), "mcp:claude-code")).toMatchObject({ ok: true, detail: expect.stringContaining(BIN) })
    writeFileSync(state, readFileSync(state, "utf8").replace(BIN, "/gone/bin.js"))
    expect(by(await run(), "mcp:claude-code")).toMatchObject({ ok: false, detail: expect.stringContaining("/gone/bin.js") })
  })

  it("legacy bx manifest makes host-manifest fail with kite install-host", async () => {
    useFixture("full")
    await init()
    writeFileSync(join(hostsDir({ browser: "chrome", home }), "com.bx.bridge.json"), "{}")
    const cs = await doctor()
    expect(by(cs, "host-manifest")).toMatchObject({ ok: false, detail: expect.stringContaining("com.bx.bridge"), fix: expect.stringContaining("kite install-host") })
  })

  it("detects a wrong allowed origin, a non-executable wrapper and a missing bin.js", async () => {
    useFixture("full")
    await init()
    const mf = join(hostsDir({ browser: "chrome", home }), "com.kitestring.bridge.json")
    const m = JSON.parse(readFileSync(mf, "utf8"))
    writeFileSync(mf, JSON.stringify({ ...m, allowed_origins: ["chrome-extension://nope/"] }))
    chmodSync(m.path, 0o644)
    const cj = join(home, ".claude.json")
    writeFileSync(cj, readFileSync(cj, "utf8").replace(/[^"]*dist\/bin\.js/, "/nonexistent/bin.js"))
    const cs = await doctor()
    expect(by(cs, "host-manifest").ok).toBe(false)
    expect(by(cs, "host-wrapper").ok).toBe(false)
    expect(by(cs, "mcp:claude-code")).toMatchObject({ ok: false, detail: expect.stringContaining("/nonexistent/bin.js") })
  })

  it("old node fails the node check", async () => {
    useFixture("partial")
    expect(by(await doctor({ nodeVersion: "20.11.0" }), "node")).toMatchObject({ ok: false })
    expect(by(await doctor({ nodeVersion: "22.12.0" }), "node").ok).toBe(true)
  })

  it("skills: a missing claude symlink fails skills:claude-code only", async () => {
    useFixture("full")
    await init()
    rmSync(join(home, ".claude", "skills", "kitestring"))
    const cs = await doctor()
    expect(by(cs, "skills:claude-code").ok).toBe(false)
    expect(by(cs, "skills:codex").ok).toBe(true)
  })

  it("cli: --json prints the array and exits 1; HOME is isolated", async () => {
    useFixture("partial")
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [BIN, "--json", "doctor"], { env: { ...process.env, HOME: home, KITE_HOME: kh, PATH: emptyBin } })
      let out = ""
      p.stdout.on("data", (d) => (out += d))
      p.on("close", (code) => resolve({ code, out }))
    })
    expect(r.code).toBe(1)
    const arr = JSON.parse(r.out)
    expect(arr.map((c: Check) => c.id)).toContain("mcp:cursor")
    expect(existsSync(join(home, "Library")) || existsSync(join(home, ".config", "google-chrome"))).toBe(false)
  })
})
