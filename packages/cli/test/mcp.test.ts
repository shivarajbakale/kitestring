import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ActionResult } from "@kitestring/protocol"
import { startDaemon, type Daemon } from "../src/host/daemon.js"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js")
const done: ActionResult = { ok: true, status: "done", diff: { added: ["button Saved"], removed: [] }, page: "Page" }
const SHOT = { mime: "image/png", data: "iVBORw0KGgo=", width: 1, height: 1 }

let dir: string
let daemon: Daemon | undefined
let received: any[]
let reply: { error: { code: string; message: string } } | undefined
let canned: unknown
let client: Client | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kitemcp-"))
  received = []
  reply = undefined
  canned = done
})
afterEach(async () => {
  await client?.close()
  client = undefined
  await daemon?.close()
  daemon = undefined
  rmSync(dir, { recursive: true, force: true })
})

async function startFake(): Promise<void> {
  const d: Daemon = await startDaemon({
    socketPath: join(dir, "kite.sock"),
    toExtension: (msg: any) => {
      received.push(msg)
      const r = reply
      const result = msg.method === "page.screenshot" ? SHOT : msg.method === "page.snapshot" ? { text: "snap text" } : canned
      queueMicrotask(() => d.fromExtension(r ? { id: msg.id, ...r } : { id: msg.id, result }))
    },
  })
  daemon = d
}

async function connect(env: Record<string, string> = {}): Promise<{ stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp"],
    env: { ...(process.env as Record<string, string>), KITE_SESSION: "", KITE_HOME: dir, ...env },
    stderr: "pipe",
  })
  let err = ""
  transport.stderr?.on("data", (d) => (err += d))
  client = new Client({ name: "test", version: "0" })
  await client.connect(transport)
  return { stderr: () => err }
}

describe("kite mcp", () => {
  it("lists all 16 tools with the server name", async () => {
    await connect()
    const { tools } = await client!.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "browser_status", "browser_tabs", "browser_tab_new", "browser_tab_use", "browser_tab_close",
        "browser_goto", "browser_snapshot", "browser_click", "browser_fill", "browser_select",
        "browser_press", "browser_scroll", "browser_console", "browser_network", "browser_screenshot", "browser_upload",
      ].sort(),
    )
    expect(tools).toHaveLength(16)
    expect(client!.getServerVersion()?.name).toBe("kitestring")
    for (const t of tools) expect(t.description).toBeTruthy()
  })
  it("click forwards act.click with text target and default session agent", async () => {
    await startFake()
    await connect()
    const r: any = await client!.callTool({ name: "browser_click", arguments: { target: "Save" } })
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text.startsWith("✓ done")).toBe(true)
    expect(received[0].method).toBe("act.click")
    expect(received[0].params.target).toEqual({ text: "Save" })
    expect(received[0].session).toBe("agent")
  })
  it("KITE_SESSION, ref target, within/role", async () => {
    await startFake()
    await connect({ KITE_SESSION: "codex" })
    await client!.callTool({ name: "browser_click", arguments: { target: "@e1k2d9" } })
    await client!.callTool({ name: "browser_fill", arguments: { target: "Name", text: "Ada", within: "Form" } })
    await client!.callTool({ name: "browser_click", arguments: { target: "Save", role: "button" } })
    expect(received[2].params.target).toEqual({ text: "Save", role: "button" })
    expect(received[0].session).toBe("codex")
    expect(received[0].params.target).toEqual({ ref: "@e1k2d9" })
    expect(received[1].method).toBe("act.fill")
    expect(received[1].params).toEqual({ target: { text: "Name", within: "Form" }, text: "Ada" })
  })
  it("maps the other tools to their RPCs", async () => {
    await startFake()
    await connect()
    const calls: [string, any, string, any][] = [
      ["browser_status", {}, "status", {}],
      ["browser_tabs", {}, "tab.list", {}],
      ["browser_tab_new", { url: "http://x" }, "tab.new", { url: "http://x" }],
      ["browser_tab_use", { id: 3 }, "tab.use", { id: 3 }],
      ["browser_tab_close", {}, "tab.close", {}],
      ["browser_goto", { url: "http://y" }, "page.goto", { url: "http://y" }],
      ["browser_snapshot", { full: true, scope: "@e1" }, "page.snapshot", { full: true, scope: "@e1" }],
      ["browser_select", { target: "Color", value: "red" }, "act.select", { target: { text: "Color" }, value: "red" }],
      ["browser_press", { key: "Enter" }, "act.press", { key: "Enter" }],
      ["browser_scroll", { direction: "down", px: 200 }, "act.scroll", { direction: "down", px: 200 }],
      ["browser_console", { level: "error" }, "page.console", { level: "error", limit: 50, clear: false }],
      ["browser_network", { failed: true }, "page.network", { failed: true, limit: 50, clear: false }],
    ]
    for (const [name, args, method, params] of calls) {
      received.length = 0
      const r: any = await client!.callTool({ name, arguments: args })
      expect(r.isError, name).toBeFalsy()
      expect(received[0].method, name).toBe(method)
      expect(received[0].params, name).toEqual(params)
    }
  })
  it("browser_upload resolves paths against the working directory and forwards act.upload", async () => {
    await startFake()
    // Not under KITE_HOME (dir), which is itself a denied location.
    const files = mkdtempSync(join(tmpdir(), "kitefiles-"))
    try {
      writeFileSync(join(files, "kite.zip"), "x")
      const want = realpathSync(files) + "/kite.zip"
      await connect()
      const r: any = await client!.callTool({ name: "browser_upload", arguments: { target: "Extension zip", files: [join(files, "kite.zip")] } })
      expect(r.isError).toBeFalsy()
      expect(received[0].method).toBe("act.upload")
      expect(received[0].params).toEqual({ target: { text: "Extension zip" }, files: [want] })
    } finally {
      rmSync(files, { recursive: true, force: true })
    }
  })
  it("browser_upload refuses a sensitive path without calling the browser", async () => {
    await startFake()
    mkdirSync(join(dir, ".ssh"))
    writeFileSync(join(dir, ".ssh", "id_rsa"), "k")
    await connect({ HOME: dir })
    const r: any = await client!.callTool({ name: "browser_upload", arguments: { target: "Extension zip", files: [join(dir, ".ssh", "id_rsa")] } })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/^BAD_REQUEST: refusing to upload .*id_rsa: sensitive location$/)
    expect(received).toHaveLength(0)
  })
  it("non-done status is information, not an error", async () => {
    canned = { ok: false, status: "not_found", detail: "no match", page: "P" }
    await startFake()
    await connect()
    const r: any = await client!.callTool({ name: "browser_click", arguments: { target: "Nope" } })
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text.startsWith("✗ not_found")).toBe(true)
  })
  it("screenshot returns image content", async () => {
    await startFake()
    await connect()
    const r: any = await client!.callTool({ name: "browser_screenshot", arguments: { full: true } })
    expect(r.content[0]).toEqual({ type: "image", data: SHOT.data, mimeType: "image/png" })
    expect(received[0].params).toEqual({ full: true })
  })
  it("NOT_CONNECTED is an error result", async () => {
    await connect() // no daemon
    const r: any = await client!.callTool({ name: "browser_snapshot", arguments: {} })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/^NOT_CONNECTED: /)
  })
  it("PAUSED is an error result", async () => {
    reply = { error: { code: "PAUSED", message: "paused by user" } }
    await startFake()
    await connect()
    const r: any = await client!.callTool({ name: "browser_click", arguments: { target: "Save" } })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe("PAUSED: paused by user")
  })
  it("a message that already starts with its code is prefixed once", async () => {
    reply = { error: { code: "PAUSED", message: "PAUSED: Kitestring is paused by the user (lunch)" } }
    await startFake()
    await connect()
    const r: any = await client!.callTool({ name: "browser_click", arguments: { target: "Save" } })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe("PAUSED: Kitestring is paused by the user (lunch)")
  })
  it("stdout carries only JSON-RPC", async () => {
    // Raw spawn: every stdout line must parse as a JSON-RPC message.
    const { spawn } = await import("node:child_process")
    const p = spawn(process.execPath, [BIN, "mcp"], { env: { ...process.env, KITE_HOME: dir } })
    let out = ""
    p.stdout.on("data", (d) => (out += d))
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n")
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_status", arguments: {} } }) + "\n")
    await new Promise((r) => setTimeout(r, 2500))
    p.kill()
    const lines = out.split("\n").filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe("2.0")
  })
})
