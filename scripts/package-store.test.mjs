import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { packageStore } from "./package-store.mjs"

function fakeBuild(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "kstore-"))
  const build = join(root, "build")
  mkdirSync(join(build, "static"), { recursive: true })
  writeFileSync(join(build, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Kitestring", version: "1.2.3", key: "SECRET" }))
  writeFileSync(join(build, "background.js"), "console.log(1)")
  writeFileSync(join(build, "static", "a.js"), "x")
  for (const [p, c] of Object.entries(extra)) writeFileSync(join(build, p), c)
  return { root, build, out: join(root, "dist") }
}
const list = (zip) => execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean)
const read = (zip, f) => execFileSync("unzip", ["-p", zip, f], { encoding: "utf8" })

test("zip drops manifest.key and contains only the build", () => {
  const { build, out } = fakeBuild()
  const r = packageStore({ buildDir: build, outDir: out })
  assert.equal(r.zip, join(out, "kitestring-1.2.3.zip"))
  assert.ok(r.bytes > 0)
  const m = JSON.parse(read(r.zip, "manifest.json"))
  assert.equal("key" in m, false)
  assert.equal(m.version, "1.2.3")
  assert.deepEqual(list(r.zip).sort(), ["background.js", "manifest.json", "static/a.js"])
})

test("fails when the build holds a .map file", () => {
  const { build, out } = fakeBuild({ "background.js.map": "{}" })
  assert.throws(() => packageStore({ buildDir: build, outDir: out }), /\.map/)
  assert.equal(existsSync(join(out, "kitestring-1.2.3.zip")), false)
})

test("fails when the build is missing a manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "kstore-"))
  mkdirSync(join(root, "b"))
  assert.throws(() => packageStore({ buildDir: join(root, "b"), outDir: join(root, "d") }), /manifest/)
})
