import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { installHost } from "../src/install/host-manifest.js"

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "bxhm-"))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it("writes manifest and wrapper", () => {
  const home = join(dir, "home")
  const r = installHost({ browser: "chrome", userDataDir: join(dir, "ud"), extensionId: "abc", bxHome: home })
  expect(r.manifestPath).toBe(join(dir, "ud", "NativeMessagingHosts", "com.bx.bridge.json"))
  const m = JSON.parse(readFileSync(r.manifestPath, "utf8"))
  expect(m.name).toBe("com.bx.bridge")
  expect(m.type).toBe("stdio")
  expect(m.path).toBe(r.wrapperPath)
  expect(m.allowed_origins).toEqual(["chrome-extension://abc/"])
  expect(r.wrapperPath).toBe(join(home, "host.sh"))
  expect(statSync(r.wrapperPath).mode & 0o111).toBeTruthy()
  const w = readFileSync(r.wrapperPath, "utf8")
  expect(w).toContain("BX_HOME=")
  expect(w).toContain(process.execPath)
  expect(w).toMatch(/dist\/host\/main\.js/)
})
