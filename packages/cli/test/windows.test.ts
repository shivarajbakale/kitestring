import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installHost } from "../src/install/host-manifest.js"
import { isOurShim, shimCmdScript, shimDir, shimPath } from "../src/install/shim.js"
import { socketPath } from "../src/paths.js"
import { windowsAgentConfigFiles } from "../src/init/agents.js"
import { isPipePath } from "../src/host/daemon.js"

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "kitewin-"))))
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("socketPath", () => {
  it("is a named pipe on win32", () => {
    expect(socketPath("win32", "alice")).toBe("\\\\.\\pipe\\kitestring-alice")
    expect(isPipePath(socketPath("win32", "alice"))).toBe(true)
  })
  it("follows process.platform by default", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32")
    expect(socketPath()).toMatch(/^\\\\\.\\pipe\\kitestring-/)
  })
  it("stays the unix socket elsewhere", () => {
    expect(socketPath("darwin")).toMatch(/kite\.sock$/)
    expect(socketPath("linux")).toMatch(/kite\.sock$/)
    expect(isPipePath(socketPath("linux"))).toBe(false)
  })
})

describe("installHost on win32", () => {
  const run = (browser: "chrome" | "chromium") => {
    const calls: Array<[string, string[]]> = []
    const r = installHost({
      browser,
      extensionId: "abc",
      kiteHome: join(dir, "kh"),
      platform: "win32",
      localAppData: join(dir, "lad"),
      execFile: (f, a) => void calls.push([f, a]),
    })
    return { r, calls }
  }

  it("writes the manifest under LOCALAPPDATA\\Kitestring and a host.cmd wrapper", () => {
    const { r } = run("chrome")
    expect(r.manifestPath).toBe(join(dir, "lad", "Kitestring", "com.kitestring.bridge.json"))
    expect(r.wrapperPath).toBe(join(dir, "kh", "host.cmd"))
    const m = JSON.parse(readFileSync(r.manifestPath, "utf8"))
    expect(m.path).toBe(r.wrapperPath)
    expect(m.allowed_origins).toEqual(["chrome-extension://abc/"])
    const w = readFileSync(r.wrapperPath, "utf8")
    expect(w).toContain("@echo off")
    expect(w).toContain(`set "KITE_HOME=${join(dir, "kh")}"`)
    expect(w).toMatch(/node[^\n]*dist[\\/]host[\\/]main\.js" %\*/)
    expect(w).toContain("\r\n")
    expect(existsSync(join(dir, "kh", "host.sh"))).toBe(false)
  })

  it("registers the manifest with reg add (Chrome)", () => {
    const { r, calls } = run("chrome")
    expect(calls).toEqual([
      ["reg", ["add", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.kitestring.bridge", "/ve", "/t", "REG_SZ", "/d", r.manifestPath, "/f"]],
    ])
  })

  it("registers under the Chromium key for chromium", () => {
    const { r, calls } = run("chromium")
    expect(calls).toEqual([
      ["reg", ["add", "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.kitestring.bridge", "/ve", "/t", "REG_SZ", "/d", r.manifestPath, "/f"]],
    ])
  })

  it("does not call reg on other platforms", () => {
    const execFile = vi.fn()
    installHost({ browser: "chrome", userDataDir: join(dir, "ud"), extensionId: "abc", kiteHome: join(dir, "kh"), platform: "linux", execFile })
    expect(execFile).not.toHaveBeenCalled()
  })
})

describe("kite.cmd shim", () => {
  it("lives in LOCALAPPDATA\\Kitestring\\bin on win32", () => {
    expect(shimDir("/k", "win32", join(dir, "lad"))).toBe(join(dir, "lad", "Kitestring", "bin"))
    expect(shimPath("/k", "win32", join(dir, "lad"))).toBe(join(dir, "lad", "Kitestring", "bin", "kite.cmd"))
    expect(shimPath("/k", "linux")).toBe(join("/k", "bin", "kite"))
  })
  it("runs node with bin.js and all args, and is recognised as ours", () => {
    const s = shimCmdScript("C:\\k", "C:\\node\\node.exe", "C:\\p\\bin.js")
    expect(s.split("\r\n")).toEqual([
      "@echo off",
      "REM kitestring cli shim (written by kite init)",
      'if "%KITE_HOME%"=="" set "KITE_HOME=C:\\k"',
      '"C:\\node\\node.exe" "C:\\p\\bin.js" %*',
      "",
    ])
    const f = join(dir, "kite.cmd")
    require("node:fs").writeFileSync(f, s)
    expect(isOurShim(f)).toBe(true)
  })
})

describe("windows agent config paths", () => {
  it("are under USERPROFILE", () => {
    expect(windowsAgentConfigFiles("C:\\Users\\a")).toEqual({
      codex: "C:\\Users\\a\\.codex\\config.toml",
      cursor: "C:\\Users\\a\\.cursor\\mcp.json",
      gemini: "C:\\Users\\a\\.gemini\\settings.json",
      opencode: "C:\\Users\\a\\.config\\opencode\\opencode.json",
    })
  })
})
