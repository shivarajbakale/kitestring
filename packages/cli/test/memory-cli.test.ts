import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { savePlan } from "../src/memory/store.js"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js")
let home: string
beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "kite-memcli-"))))
afterEach(() => rmSync(home, { recursive: true, force: true }))
const kite = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a], { env: { ...process.env, KITE_HOME: home }, encoding: "utf8" })

describe("kite memory", () => {
  it("list / show / forget", () => {
    expect(kite("memory", "list").stdout).toContain("no saved plans")
    savePlan(home, {
      version: 1, intent: "publish listing", origin: "https://a.example.com", pathPattern: "/",
      params: [{ name: "title", secret: false }, { name: "password", secret: true }],
      batches: [[{ action: "fill", target: { text: "Title", role: "textbox" }, value: "{{title}}" }]],
      createdAt: "2026-01-01T00:00:00.000Z", runs: 2, lastOk: null,
    })
    const l = kite("memory", "list")
    expect(l.stdout).toContain("a-example-com/publish-listing")
    expect(l.stdout).toContain("title, password*")
    expect(JSON.parse(kite("memory", "show", "publish-listing").stdout).intent).toBe("publish listing")
    expect(kite("memory", "forget", "publish-listing").status).toBe(0)
    const gone = kite("memory", "forget", "publish-listing")
    expect(gone.status).toBe(2)
    expect(gone.stderr).toContain("no such plan")
    expect(kite("memory", "list").stdout).toContain("no saved plans")
  })
})
