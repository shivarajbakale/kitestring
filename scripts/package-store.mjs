#!/usr/bin/env node
// Builds the production extension and zips it for the Chrome Web Store.
// Strips manifest.key (the Store assigns its own id), refuses source maps and anything outside the build.
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function walk(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (lstatSync(p).isSymbolicLink()) throw new Error(`build contains a symlink: ${relative(base, p)}`)
    if (statSync(p).isDirectory()) out.push(...walk(p, base))
    else out.push(relative(base, p).split("\\").join("/"))
  }
  return out
}

/** Files and folders that must never ship in a Store zip. */
export function forbidden(rel) {
  const parts = rel.split("/")
  const name = parts[parts.length - 1]
  if (parts.slice(0, -1).includes("keys")) return true
  return name.startsWith(".") || /\.(pem|key)$/.test(name) || name === "key.json"
}

/** Zips `buildDir` (already built) into `<outDir>/kitestring-<version>.zip`. Throws on any problem. */
export function packageStore({ buildDir, outDir }) {
  const manifestPath = join(buildDir, "manifest.json")
  if (!existsSync(manifestPath)) throw new Error(`no manifest.json in ${buildDir} — build the extension first`)
  const tmp = mkdtempSync(join(tmpdir(), "kstore-pkg-"))
  try {
    const stage = join(tmp, "stage")
    cpSync(buildDir, stage, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"))
    delete manifest.key
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    const files = walk(stage)
    const bad = files.filter(forbidden)
    if (bad.length) throw new Error(`build contains files that must not ship: ${bad.join(", ")}`)
    const maps = files.filter((f) => f.endsWith(".map"))
    if (maps.length) throw new Error(`build contains source maps (.map): ${maps.join(", ")}`)
    if (typeof manifest.version !== "string") throw new Error("manifest has no version")
    mkdirSync(outDir, { recursive: true })
    const zip = join(outDir, `kitestring-${manifest.version}.zip`)
    rmSync(zip, { force: true })
    try {
      execFileSync("zip", ["-q", "-r", "-X", zip, ...files.sort()], { cwd: stage })
    } catch (e) {
      if (e && e.code === "ENOENT") throw new Error("packaging needs the `zip` and `unzip` programs on PATH (macOS or Linux)")
      throw e
    }

    // Verify the archive itself: same files as the stage, no key, no maps.
    const listed = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean).sort()
    const expected = [...files].sort()
    if (JSON.stringify(listed) !== JSON.stringify(expected)) {
      rmSync(zip, { force: true })
      throw new Error(`zip contents differ from the build: ${listed.join(", ")}`)
    }
    const zipped = JSON.parse(execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" }))
    if ("key" in zipped) {
      rmSync(zip, { force: true })
      throw new Error("zipped manifest still has a key")
    }
    return { zip, bytes: statSync(zip).size, files: listed.length, version: manifest.version }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ext = join(ROOT, "packages", "extension")
  rmSync(join(ext, "build", "chrome-mv3-prod"), { recursive: true, force: true }) // no stale files
  execFileSync("pnpm", ["exec", "plasmo", "build"], { cwd: ext, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } })
  const r = packageStore({ buildDir: join(ext, "build", "chrome-mv3-prod"), outDir: join(ROOT, "dist") })
  console.log(`${r.zip}\n${(r.bytes / 1024).toFixed(1)} KiB, ${r.files} files, version ${r.version}`)
}
