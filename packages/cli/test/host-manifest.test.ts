import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { installHost } from "../src/install/host-manifest.js"

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "kitehm-"))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it("writes manifest and wrapper", () => {
  const home = join(dir, "home")
  const r = installHost({ browser: "chrome", userDataDir: join(dir, "ud"), extensionId: "abc", kiteHome: home })
  expect(r.manifestPath).toBe(join(dir, "ud", "NativeMessagingHosts", "com.kitestring.bridge.json"))
  const m = JSON.parse(readFileSync(r.manifestPath, "utf8"))
  expect(m.name).toBe("com.kitestring.bridge")
  expect(m.type).toBe("stdio")
  expect(m.path).toBe(r.wrapperPath)
  expect(m.allowed_origins).toEqual(["chrome-extension://abc/"])
  expect(r.wrapperPath).toBe(join(home, "host.sh"))
  expect(statSync(r.wrapperPath).mode & 0o111).toBeTruthy()
  const w = readFileSync(r.wrapperPath, "utf8")
  expect(w).toContain("KITE_HOME=")
  expect(w).toContain("for n in ")
  expect(w).toContain("exec \"$n\"")
  expect(w).toContain("kitestring: no node found")
  expect(w).toContain("exit 127")
  expect(w).toMatch(/dist\/host\/main\.js/)
})

it("removes legacy com.bx.bridge manifest and reports it", () => {
  const hosts = join(dir, "ud", "NativeMessagingHosts")
  mkdirSync(hosts, { recursive: true })
  const legacy = join(hosts, "com.bx.bridge.json")
  writeFileSync(legacy, "{}")
  const r = installHost({ browser: "chrome", userDataDir: join(dir, "ud"), extensionId: "abc", kiteHome: join(dir, "home") })
  expect(r.removedLegacy).toEqual([legacy])
  expect(existsSync(legacy)).toBe(false)
  expect(existsSync(r.manifestPath)).toBe(true)
  expect(installHost({ browser: "chrome", userDataDir: join(dir, "ud"), extensionId: "abc", kiteHome: join(dir, "home") }).removedLegacy).toEqual([])
})
