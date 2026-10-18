import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { KiteError } from "../src/client/rpc-client.js"
import { resolveUploads } from "../src/upload-guard.js"

let root: string
let home: string
let cwd: string
let kiteHome: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kiteup-"))
  home = join(root, "home")
  cwd = join(root, "work")
  kiteHome = join(home, ".kitestring")
  for (const d of [home, cwd, kiteHome, join(home, ".ssh"), join(home, ".config", "x")]) mkdirSync(d, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const opts = (env: NodeJS.ProcessEnv = {}) => ({ cwd, home, kiteHome, env })
function refusal(paths: string[], env: NodeJS.ProcessEnv = {}): string {
  try {
    resolveUploads(paths, opts(env))
  } catch (e) {
    expect(e).toBeInstanceOf(KiteError)
    expect((e as KiteError).code).toBe("BAD_REQUEST")
    return (e as KiteError).message
  }
  throw new Error("expected a refusal")
}

describe("resolveUploads", () => {
  it("resolves relative paths against cwd, to real paths", () => {
    writeFileSync(join(cwd, "a.zip"), "x")
    const [p] = resolveUploads(["a.zip"], opts())
    expect(p.endsWith("/work/a.zip")).toBe(true)
    expect(p.startsWith("/")).toBe(true)
  })

  it("missing file: not found", () => {
    expect(refusal(["nope.png"])).toBe("refusing to upload nope.png: not found")
  })

  it("directory: not a regular file", () => {
    expect(refusal([cwd])).toBe(`refusing to upload ${cwd}: not a regular file`)
  })

  it("~/.ssh file: sensitive location", () => {
    const f = join(home, ".ssh", "id_ed25519")
    writeFileSync(f, "k")
    expect(refusal([f])).toBe(`refusing to upload ${f}: sensitive location`)
  })

  it("each denied directory is refused", () => {
    for (const d of [".aws", ".gnupg", ".kitestring", ".config/x", "Library/Keychains"]) {
      mkdirSync(join(home, d), { recursive: true })
      const f = join(home, d, "f.txt")
      writeFileSync(f, "k")
      expect(refusal([f]), d).toContain("sensitive location")
    }
  })

  it("$KITE_HOME outside ~ is refused too", () => {
    const elsewhere = join(root, "kh")
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, "token"), "t")
    expect(() => resolveUploads([join(elsewhere, "token")], { cwd, home, kiteHome: elsewhere, env: {} })).toThrow(/sensitive location/)
  })

  it("a symlink in cwd into ~/.ssh is refused (checked after realpath)", () => {
    writeFileSync(join(home, ".ssh", "id_rsa"), "k")
    symlinkSync(join(home, ".ssh", "id_rsa"), join(cwd, "innocent.txt"))
    expect(refusal(["innocent.txt"])).toBe("refusing to upload innocent.txt: sensitive location")
  })

  it("a symlinked directory in cwd into ~/.ssh is refused", () => {
    writeFileSync(join(home, ".ssh", "id_rsa"), "k")
    symlinkSync(join(home, ".ssh"), join(cwd, "d"))
    expect(refusal(["d/id_rsa"])).toContain("sensitive location")
  })

  it(".env* anywhere: sensitive location", () => {
    writeFileSync(join(cwd, ".env.local"), "S=1")
    writeFileSync(join(cwd, ".env"), "S=1")
    expect(refusal([".env.local"])).toContain("sensitive location")
    expect(refusal([".env"])).toContain("sensitive location")
    writeFileSync(join(cwd, "env.txt"), "ok")
    expect(resolveUploads(["env.txt"], opts())).toHaveLength(1)
  })

  it("a symlink named innocently to a .env file is refused", () => {
    writeFileSync(join(cwd, ".env"), "S=1")
    symlinkSync(join(cwd, ".env"), join(cwd, "notes.txt"))
    expect(refusal(["notes.txt"])).toContain("sensitive location")
  })

  it("KITE_UPLOAD_ALLOW overrides the location rule for its directories only", () => {
    const f = join(home, ".config", "x", "app.json")
    writeFileSync(f, "{}")
    const other = join(home, ".config", "y.json")
    writeFileSync(other, "{}")
    const env = { KITE_UPLOAD_ALLOW: `/nonexistent:${join(home, ".config", "x")}` }
    expect(resolveUploads([f], opts(env))).toHaveLength(1)
    expect(refusal([other], env)).toContain("sensitive location")
  })

  it("KITE_UPLOAD_ALLOW does not override size or type", () => {
    const big = join(home, ".config", "x", "big.bin")
    writeFileSync(big, "")
    truncateSync(big, 101 * 1024 * 1024)
    const env = { KITE_UPLOAD_ALLOW: join(home, ".config", "x") }
    expect(refusal([big], env)).toContain("larger than 100 MB")
    expect(refusal([join(home, ".config", "x")], env)).toContain("not a regular file")
  })

  it("101 MB sparse file: larger than 100 MB; exactly 100 MiB is fine", () => {
    const big = join(cwd, "big.bin")
    writeFileSync(big, "")
    truncateSync(big, 101 * 1024 * 1024)
    expect(refusal([big])).toBe(`refusing to upload ${big}: larger than 100 MB`)
    truncateSync(big, 104_857_600)
    expect(resolveUploads([big], opts())).toHaveLength(1)
  })

  it("checks every path and returns them in order", () => {
    writeFileSync(join(cwd, "1.png"), "1")
    writeFileSync(join(cwd, "2.png"), "2")
    expect(resolveUploads(["2.png", "1.png"], opts()).map((p) => p.slice(-5))).toEqual(["2.png", "1.png"])
    expect(refusal(["1.png", "missing.png"])).toContain("missing.png")
  })
})
