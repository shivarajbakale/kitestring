import { spawnSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseJsonc } from "jsonc-parser"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveNode } from "../src/init/node-path.js"
import { detect } from "../src/init/detect.js"
import { jsonRemove, jsonSet } from "../src/init/json-edit.js"
import { tomlRemoveTable, tomlSetTable } from "../src/init/toml-edit.js"
import { runInit, runUninstall, type InitOptions } from "../src/init/init.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, "fixtures", "homes")
const BIN = join(HERE, "..", "dist", "bin.js")
const CLI_BIN = realpathSync(join(HERE, "..")) + "/dist/bin.js"
const NODE = "/opt/test/bin/node"
const SKILL_NAMES = ["kitestring", "kitestring-debug-frontend", "kitestring-e2e-verify"]

let tmp: string
let home: string
let emptyBin: string
let out: string[]

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "kiteinit-")))
  emptyBin = join(tmp, "emptybin")
  mkdirSync(emptyBin)
  out = []
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function useFixture(name: string): string {
  home = join(tmp, "home")
  cpSync(join(FIXTURES, name), home, { recursive: true })
  return home
}

function opts(extra: Partial<InitOptions> = {}): InitOptions {
  // SAFETY: every path is under the temp dir; PATH has no `claude`.
  expect(home.startsWith(tmp + sep)).toBe(true)
  return {
    home,
    env: { PATH: emptyBin, KITE_HOME: join(tmp, "kitehome") },
    node: NODE,
    yes: true,
    out: (s) => out.push(s),
    isConnected: async () => false,
    now: new Date(2026, 9, 18, 12, 0, 0),
    ...extra,
  }
}

const isHostPath = (rel: string) =>
  rel.startsWith("Library") || rel.startsWith(join(".config", "google-chrome")) || rel.startsWith(join(".config", "chromium"))

/** Every file/symlink under dir (minus native host files), as rel → content | "-> target". */
function snapshot(dir: string, { backups = true } = {}): Record<string, string> {
  const r: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const rel = relative(dir, p)
      if (isHostPath(rel)) continue
      if (!backups && /\.kite-backup-\d{14}(\.\d+)?$/.test(e)) continue
      const st = lstatSync(p)
      if (st.isSymbolicLink()) r[rel] = "-> " + readlinkSync(p)
      else if (st.isDirectory()) {
        r[rel + "/"] = "dir"
        walk(p)
      } else r[rel] = readFileSync(p, "utf8")
    }
  }
  walk(dir)
  return r
}

const backupsIn = (dir: string) => Object.keys(snapshot(dir)).filter((k) => /\.kite-backup-\d{14}(\.\d+)?$/.test(k))
const read = (rel: string) => readFileSync(join(home, rel), "utf8")
const fixture = (name: string, rel: string) => readFileSync(join(FIXTURES, name, rel), "utf8")
const jsonc = (s: string) => parseJsonc(s, [], { allowTrailingComma: true })

/** Asserts `after` is `before` with one contiguous insertion (no other byte changed). */
function expectPureInsertion(before: string, after: string) {
  let i = 0
  while (i < before.length && before[i] === after[i]) i++
  let j = 0
  while (j < before.length - i && before[before.length - 1 - j] === after[after.length - 1 - j]) j++
  expect(i + j, "only an insertion, nothing replaced or removed").toBe(before.length)
  expect(after.length).toBeGreaterThan(before.length)
}

describe("detect", () => {
  it("finds agents by config dir", () => {
    useFixture("full")
    expect(detect(home).filter((a) => a.present).map((a) => a.id)).toEqual(["claude-code", "codex", "cursor", "gemini", "opencode"])
    useFixture("partial")
  })
  it("partial home has only cursor", () => {
    useFixture("partial")
    expect(detect(home).filter((a) => a.present).map((a) => a.id)).toEqual(["cursor"])
  })
})

describe("json-edit", () => {
  it("round-trips insert and remove byte-for-byte, keeping comments and trailing commas", () => {
    const t = fixture("full", ".config/opencode/opencode.jsonc")
    const a = jsonSet(t, ["mcp", "kitestring"], { a: [1, 2] })
    expectPureInsertion(t, a)
    expect(jsonc(a).mcp.kitestring).toEqual({ a: [1, 2] })
    expect(jsonSet(a, ["mcp", "kitestring"], { a: [1, 2] })).toBe(a)
    expect(jsonRemove(a, ["mcp", "kitestring"])).toBe(t)
  })
  it("refuses to remove an entry when that would delete a neighbouring comment", () => {
    const first = `{\n  "mcp": {\n    "kitestring": { "a": 1 },\n    // my other server\n    "other": { "b": 2 }\n  }\n}\n`
    expect(() => jsonRemove(first, ["mcp", "kitestring"])).toThrow(/comment/)
    const last = `{\n  "mcp": {\n    "foo": 1, // foo note\n    "kitestring": { "a": 1 }\n  }\n}\n`
    expect(() => jsonRemove(last, ["mcp", "kitestring"])).toThrow(/comment/)
    // comments elsewhere in the object are fine
    const ok = `{\n  "mcp": {\n    // servers\n    "foo": 1,\n    "kitestring": { "a": 1 }\n  }\n}\n`
    expect(jsonRemove(ok, ["mcp", "kitestring"])).toBe(`{\n  "mcp": {\n    // servers\n    "foo": 1\n  }\n}\n`)
    // an emptied container that carries a comment is kept
    const lone = `{\n  "x": 1,\n  "mcp": { /* mine */ "kitestring": 1 }\n}\n`
    expect(jsonRemove(lone, ["mcp", "kitestring"])).toBe(`{\n  "x": 1,\n  "mcp": { /* mine */  }\n}\n`)
  })

  it("creates and removes a missing parent", () => {
    const t = `{\n  "theme": "dark"\n}\n`
    const a = jsonSet(t, ["mcpServers", "kitestring"], { command: "n" })
    expect(JSON.parse(a)).toEqual({ theme: "dark", mcpServers: { kitestring: { command: "n" } } })
    expect(jsonRemove(a, ["mcpServers", "kitestring"])).toBe(t)
  })
  it("uses the file's indentation (tabs)", () => {
    const t = fixture("full", ".cursor/mcp.json")
    const a = jsonSet(t, ["mcpServers", "kitestring"], { command: "n" })
    expect(a).toContain(`\n\t\t"kitestring": {\n\t\t\t"command": "n"\n\t\t}`)
  })
  it("replaces a differing value in place", () => {
    const t = `{\n  "mcp": {\n    "kitestring": { "old": true },\n    "x": 1\n  }\n}\n`
    const a = jsonSet(t, ["mcp", "kitestring"], { new: 1 })
    expect(JSON.parse(a)).toEqual({ mcp: { kitestring: { new: 1 }, x: 1 } })
    expect(a.endsWith(`,\n    "x": 1\n  }\n}\n`)).toBe(true)
  })
})

describe("toml-edit", () => {
  const block = `[mcp_servers.kitestring]\ncommand = "n"\n\n[mcp_servers.kitestring.env]\nKITE_SESSION = "codex"`
  it("appends, is idempotent, and removes back to the original", () => {
    const t = fixture("full", ".codex/config.toml")
    const a = tomlSetTable(t, "mcp_servers.kitestring", block)
    expectPureInsertion(t, a)
    expect(tomlSetTable(a, "mcp_servers.kitestring", block)).toBe(a)
    expect(tomlRemoveTable(a, "mcp_servers.kitestring")).toBe(t)
  })
  it("refuses to add a [table] when the server is already defined inline or with dotted keys", () => {
    const inline = `[mcp_servers]\nkitestring = { command = "x" }\n`
    expect(() => tomlSetTable(inline, "mcp_servers.kitestring", block)).toThrow(/line 2/)
    const dotted = `model = "m"\nmcp_servers.kitestring.command = "x"\n`
    expect(() => tomlSetTable(dotted, "mcp_servers.kitestring", block)).toThrow(/line 2/)
    const quoted = `[mcp_servers]\n"kitestring".command = "x"\n`
    expect(() => tomlSetTable(quoted, "mcp_servers.kitestring", block)).toThrow(/edit it by hand/)
    // a multi-line array value whose lines look like headers is not a definition
    const arr = `[x]\nargs = [\n  ["mcp_servers.kitestring"],\n]\n`
    expect(tomlSetTable(arr, "mcp_servers.kitestring", block)).toContain("[mcp_servers.kitestring]")
  })

  it("replaces an existing table + env subtable in the middle, leaving neighbours alone", () => {
    const t = `# top\n[a]\nx = 1\n\n[mcp_servers.kitestring]\ncommand = "old"\nargs = ["x"]\n\n[mcp_servers.kitestring.env]\nKITE_SESSION = "zzz"\n\n# about b\n[b]\ny = 2\n`
    const a = tomlSetTable(t, "mcp_servers.kitestring", block)
    expect(a).toBe(`# top\n[a]\nx = 1\n\n${block}\n\n# about b\n[b]\ny = 2\n`)
    expect(tomlRemoveTable(a, "mcp_servers.kitestring")).toBe(`# top\n[a]\nx = 1\n\n# about b\n[b]\ny = 2\n`)
  })
})

describe("kite init", () => {
  it("writes exactly the kitestring entry for each agent, preserving every other byte", async () => {
    useFixture("full")
    const code = await runInit(opts())
    expect(code).toBe(0)
    const bin = join(dirname(BIN), "bin.js")

    // Claude Code (no `claude` on PATH → ~/.claude.json)
    const claude = read(".claude.json")
    expectPureInsertion(fixture("full", ".claude.json"), claude)
    expect(JSON.parse(claude).mcpServers.kitestring).toEqual({
      type: "stdio",
      command: NODE,
      args: [bin, "mcp"],
      env: { KITE_SESSION: "claude-code" },
    })

    // Codex
    const toml = read(".codex/config.toml")
    expectPureInsertion(fixture("full", ".codex/config.toml"), toml)
    expect(toml.endsWith(
      `\n[mcp_servers.kitestring]\ncommand = "${NODE}"\nargs = ["${bin}", "mcp"]\nstartup_timeout_sec = 20\ntool_timeout_sec = 60\n\n[mcp_servers.kitestring.env]\nKITE_SESSION = "codex"\n`,
    )).toBe(true)

    // Cursor
    const cursor = read(".cursor/mcp.json")
    expectPureInsertion(fixture("full", ".cursor/mcp.json"), cursor)
    expect(JSON.parse(cursor).mcpServers.kitestring).toEqual({
      type: "stdio",
      command: NODE,
      args: [bin, "mcp"],
      env: { KITE_SESSION: "cursor" },
    })

    // Gemini (JSONC with trailing comma)
    const gem = read(".gemini/settings.json")
    expectPureInsertion(fixture("full", ".gemini/settings.json"), gem)
    expect(jsonc(gem).mcpServers.kitestring).toEqual({
      command: NODE,
      args: [bin, "mcp"],
      env: { KITE_SESSION: "gemini" },
      timeout: 60000,
    })

    // OpenCode: .jsonc wins, .json untouched
    const oc = read(".config/opencode/opencode.jsonc")
    expectPureInsertion(fixture("full", ".config/opencode/opencode.jsonc"), oc)
    expect(jsonc(oc).mcp.kitestring).toEqual({
      type: "local",
      command: [NODE, bin, "mcp"],
      enabled: true,
      environment: { KITE_SESSION: "opencode" },
      timeout: 15000,
    })
    expect(read(".config/opencode/opencode.json")).toBe(fixture("full", ".config/opencode/opencode.json"))

    // one backup per changed file, original content
    const backups = backupsIn(home).sort()
    expect(backups).toEqual(
      [
        ".claude.json.kite-backup-20261018120000",
        ".codex/config.toml.kite-backup-20261018120000",
        ".config/opencode/opencode.jsonc.kite-backup-20261018120000",
        ".cursor/mcp.json.kite-backup-20261018120000",
        ".gemini/settings.json.kite-backup-20261018120000",
      ].map((p) => p.split("/").join(sep)),
    )
    expect(read(".codex/config.toml.kite-backup-20261018120000")).toBe(fixture("full", ".codex/config.toml"))
    // no temp files left behind
    expect(Object.keys(snapshot(home)).filter((k) => k.includes("kite-tmp"))).toEqual([])
  })

  it("installs skills into ~/.agents/skills with ~/.claude/skills symlinks", async () => {
    useFixture("full")
    // a stale symlink of ours pointing elsewhere is replaced
    mkdirSync(join(home, ".claude", "skills"))
    symlinkSync(join(tmp, "nowhere"), join(home, ".claude", "skills", "kitestring-debug-frontend"))
    expect(await runInit(opts())).toBe(0)
    for (const n of SKILL_NAMES) {
      const real = join(home, ".agents", "skills", n)
      expect(lstatSync(real).isDirectory()).toBe(true)
      expect(readFileSync(join(real, "SKILL.md"), "utf8")).toContain(`name: ${n}`)
      const link = join(home, ".claude", "skills", n)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(real)
    }
    expect(existsSync(join(home, ".agents", "skills", "kitestring", "reference", "recovery.md"))).toBe(true)
    expect(existsSync(join(home, ".agents", "skills", "TESTING.md"))).toBe(false)
    expect(read(".agents/skills/other-skill/SKILL.md")).toBe(fixture("full", ".agents/skills/other-skill/SKILL.md"))
  })

  it("is idempotent: second run changes nothing and makes no new backups", async () => {
    useFixture("full")
    expect(await runInit(opts())).toBe(0)
    const first = snapshot(home)
    out = []
    expect(await runInit(opts({ now: new Date(2026, 9, 18, 12, 5, 0) }))).toBe(0)
    expect(snapshot(home)).toEqual(first)
    expect(out.join("\n")).toMatch(/up to date/i)
  })

  it("skips an agent that is not installed, without creating its config dir", async () => {
    useFixture("partial")
    expect(await runInit(opts())).toBe(0)
    for (const d of [".gemini", ".codex", ".claude", ".config/opencode"]) expect(existsSync(join(home, d)), d).toBe(false)
    expect(existsSync(join(home, ".claude.json"))).toBe(false)
    const text = out.join("\n")
    expect(text).toMatch(/^gemini: not installed \(no ~\/\.gemini\) — skipped$/m)
    expect(JSON.parse(read(".cursor/mcp.json")).mcpServers.kitestring.env).toEqual({ KITE_SESSION: "cursor" })
    // skills still land in ~/.agents/skills; no ~/.claude so no symlinks
    expect(existsSync(join(home, ".agents", "skills", "kitestring", "SKILL.md"))).toBe(true)
  })

  it("leaves an unparseable config alone and reports it", async () => {
    useFixture("full")
    writeFileSync(join(home, ".cursor", "mcp.json"), `{ "mcpServers": { "a": 1 `)
    expect(await runInit(opts())).toBe(1)
    expect(read(".cursor/mcp.json")).toBe(`{ "mcpServers": { "a": 1 `)
    expect(out.join("\n")).toMatch(/cursor: .*mcp\.json: not valid JSON\/JSONC/)
    expect(JSON.parse(read(".claude.json")).mcpServers.kitestring).toBeDefined()
  })

  it("reports a Codex config that defines the server inline and leaves it unchanged", async () => {
    useFixture("full")
    const t = `[mcp_servers]\nkitestring = { command = "x" }\n`
    writeFileSync(join(home, ".codex", "config.toml"), t)
    expect(await runInit(opts())).toBe(1)
    expect(read(".codex/config.toml")).toBe(t)
    expect(out.join("\n")).toMatch(/codex: .*config\.toml: mcp_servers\.kitestring is already defined as a key/)
  })

  it("keeps an existing file's mode and creates new files 0600", async () => {
    useFixture("full")
    chmodSync(join(home, ".cursor", "mcp.json"), 0o640)
    rmSync(join(home, ".config", "opencode", "opencode.json"))
    rmSync(join(home, ".config", "opencode", "opencode.jsonc"))
    expect(await runInit(opts())).toBe(0)
    expect(statSync(join(home, ".cursor", "mcp.json")).mode & 0o777).toBe(0o640)
    expect(statSync(join(home, ".config", "opencode", "opencode.json")).mode & 0o777).toBe(0o600)
  })

  it("moves a modified skill folder to a backup outside the skills dirs before replacing it", async () => {
    useFixture("full")
    const mine = join(home, ".agents", "skills", "kitestring")
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, "SKILL.md"), "my edits\n")
    expect(await runInit(opts())).toBe(0)
    const text = out.join("\n")
    const backup = join(home, ".agents", "kite-backups", "skills", "kitestring.kite-backup-20261018120000")
    expect(text).toContain(`replace modified ${mine}`)
    expect(text).toContain(backup)
    expect(readFileSync(join(backup, "SKILL.md"), "utf8")).toBe("my edits\n")
    expect(readFileSync(join(mine, "SKILL.md"), "utf8")).toContain("name: kitestring")
  })

  it("--agents limits to the named agents", async () => {
    useFixture("full")
    expect(await runInit(opts({ agents: ["cursor"] }))).toBe(0)
    expect(read(".codex/config.toml")).toBe(fixture("full", ".codex/config.toml"))
    expect(read(".cursor/mcp.json")).not.toBe(fixture("full", ".cursor/mcp.json"))
  })

  it("--dry-run writes nothing and prints the plan", async () => {
    useFixture("full")
    const before = snapshot(home)
    expect(await runInit(opts({ dryRun: true }))).toBe(0)
    expect(snapshot(home)).toEqual(before)
    expect(existsSync(join(tmp, "kitehome"))).toBe(false)
    const text = out.join("\n")
    expect(text).toContain(join(home, ".codex", "config.toml"))
    expect(text).toContain(join(home, ".agents", "skills", "kitestring"))
    expect(text).toMatch(/dry run/i)
  })

  it("refuses to overwrite a real ~/.claude/skills/<name> directory and reports it", async () => {
    useFixture("refuse")
    expect(await runInit(opts())).toBe(1)
    expect(read(".claude/skills/kitestring/SKILL.md")).toBe(fixture("refuse", ".claude/skills/kitestring/SKILL.md"))
    expect(lstatSync(join(home, ".claude/skills/kitestring")).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(home, ".claude/skills/kitestring-e2e-verify")).isSymbolicLink()).toBe(true)
    expect(out.join("\n")).toMatch(/not a symlink.*left alone/)
  })

  it("installs the native host into the injected home and prints extension steps when not connected", async () => {
    useFixture("partial")
    expect(await runInit(opts())).toBe(0)
    const hostFiles = Object.keys(snapshotAll(home)).filter((k) => k.endsWith("com.kitestring.bridge.json"))
    expect(hostFiles.length).toBe(1)
    expect(existsSync(join(tmp, "kitehome", "host.sh"))).toBe(true)
    const text = out.join("\n")
    expect(text).toContain("bdfegcbeenjmlbfogodoibdhfbonnicm")
    expect(text).toContain(join("packages", "extension", "build", "chrome-mv3-prod"))
  })

  it("skips the extension steps when the extension is connected", async () => {
    useFixture("partial")
    expect(await runInit(opts({ isConnected: async () => true }))).toBe(0)
    expect(out.join("\n")).not.toContain("chrome-mv3-prod")
    expect(out.join("\n")).toMatch(/extension connected/i)
  })

  it("without --yes on a non-TTY prints the plan and exits 2 without writing", async () => {
    useFixture("full")
    const before = snapshot(home)
    expect(await runInit(opts({ yes: false, tty: false }))).toBe(2)
    expect(snapshot(home)).toEqual(before)
    expect(out.join("\n")).toContain(join(home, ".cursor", "mcp.json"))
  })

  it("on a TTY asks and aborts on no", async () => {
    useFixture("full")
    const before = snapshot(home)
    let asked = ""
    expect(await runInit(opts({ yes: false, tty: true, confirm: async (q) => ((asked = q), false) }))).toBe(1)
    expect(asked).toBe("Proceed? [y/N] ")
    expect(snapshot(home)).toEqual(before)
  })
})

/** Snapshot including host files. */
function snapshotAll(dir: string): Record<string, string> {
  const r: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = lstatSync(p)
      if (st.isDirectory()) walk(p)
      else r[relative(dir, p)] = st.isSymbolicLink() ? "link" : "file"
    }
  }
  walk(dir)
  return r
}

describe("kite uninstall-agents", () => {
  it("restores every config to the fixture (only backups differ) and removes our skills + symlinks", async () => {
    useFixture("full")
    expect(await runInit(opts())).toBe(0)
    out = []
    expect(await runUninstall(opts({ now: new Date(2026, 9, 18, 13, 0, 0) }))).toBe(0)
    const after = snapshot(home, { backups: false })
    const orig = snapshot(join(FIXTURES, "full"))
    // ~/.agents/skills and ~/.claude/skills dirs may remain (empty containers we created)
    delete after[".claude/skills/"]
    expect(after).toEqual(orig)
    expect(backupsIn(home).filter((b) => b.endsWith("20261018130000")).length).toBe(5)
    expect(out.join("\n")).toMatch(/native host manifest.*kept/i)
  })

  it("leaves a non-symlink ~/.claude/skills/<name> and a symlink pointing elsewhere alone", async () => {
    useFixture("refuse")
    await runInit(opts())
    rmSync(join(home, ".claude/skills/kitestring-e2e-verify"))
    symlinkSync(join(tmp, "elsewhere"), join(home, ".claude/skills/kitestring-e2e-verify"))
    expect(await runUninstall(opts())).toBe(0)
    expect(read(".claude/skills/kitestring/SKILL.md")).toBe(fixture("refuse", ".claude/skills/kitestring/SKILL.md"))
    expect(readlinkSync(join(home, ".claude/skills/kitestring-e2e-verify"))).toBe(join(tmp, "elsewhere"))
    expect(existsSync(join(home, ".claude/skills/kitestring-debug-frontend"))).toBe(false)
    expect(existsSync(join(home, ".agents/skills/kitestring"))).toBe(false)
  })

  it("never overwrites an earlier backup made in the same second", async () => {
    useFixture("full")
    await runInit(opts())
    expect(await runUninstall(opts())).toBe(0)
    expect(read(".cursor/mcp.json.kite-backup-20261018120000")).toBe(fixture("full", ".cursor/mcp.json"))
    expect(JSON.parse(read(".cursor/mcp.json.kite-backup-20261018120000.1")).mcpServers.kitestring).toBeDefined()
  })

  it("leaves a skill folder that differs from the repo copy (user-edited) alone", async () => {
    useFixture("full")
    await runInit(opts())
    writeFileSync(join(home, ".agents", "skills", "kitestring-e2e-verify", "NOTES.md"), "mine\n")
    expect(await runUninstall(opts())).toBe(0)
    expect(read(".agents/skills/kitestring-e2e-verify/NOTES.md")).toBe("mine\n")
    expect(existsSync(join(home, ".agents", "skills", "kitestring"))).toBe(false)
    expect(out.join("\n")).toMatch(/kitestring-e2e-verify differs from .* \(modified\) — left alone/)
  })

  it("--dry-run writes nothing", async () => {
    useFixture("full")
    await runInit(opts())
    const before = snapshot(home)
    expect(await runUninstall(opts({ dryRun: true }))).toBe(0)
    expect(snapshot(home)).toEqual(before)
  })
})

describe("Claude Code via the claude CLI", () => {
  /** A fake `claude` that logs argv and keeps one user-scope entry in a state file. */
  function fakeClaude(): { dir: string; log: string; state: string } {
    const dir = join(tmp, "fakebin")
    mkdirSync(dir)
    const log = join(tmp, "claude-argv.log")
    const state = join(tmp, "claude-state")
    const script = `#!/bin/sh
PATH=/usr/bin:/bin
printf '%s\\n' "$*" >> '${log}'
if [ "$1 $2" = "mcp get" ]; then
  [ -f '${state}' ] || { echo "No MCP server found with name: $3" >&2; exit 1; }
  cat '${state}'; exit 0
fi
if [ "$1 $2" = "mcp remove" ]; then rm -f '${state}'; exit 0; fi
if [ "$1 $2" = "mcp add" ]; then
  shift 2
  env=""; name=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --transport|--scope) shift 2;;
      -e) env="$2"; shift 2;;
      --) shift; break;;
      *) name="$1"; shift;;
    esac
  done
  cmd="$1"; shift
  printf '%s:\\n  Scope: User config (available in all your projects)\\n  Status: ✓ Connected\\n  Type: stdio\\n  Command: %s\\n  Args: %s\\n  Environment:\\n    %s\\n' "$name" "$cmd" "$*" "$env" > '${state}'
  exit 0
fi
exit 3
`
    writeFileSync(join(dir, "claude"), script)
    chmodSync(join(dir, "claude"), 0o755)
    return { dir, log, state }
  }
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : [])

  it("registers via `claude mcp add` (no shell), leaves ~/.claude.json alone, and is idempotent", async () => {
    useFixture("full")
    const fake = fakeClaude()
    const o = opts({ agents: ["claude-code"], env: { PATH: fake.dir, KITE_HOME: join(tmp, "kitehome") } })
    expect(await runInit(o)).toBe(0)
    const bin = join(dirname(BIN), "bin.js")
    expect(lines(fake.log)).toEqual([
      "mcp get kitestring",
      `mcp add --transport stdio --scope user kitestring -e KITE_SESSION=claude-code -- ${NODE} ${bin} mcp`,
    ])
    expect(read(".claude.json")).toBe(fixture("full", ".claude.json"))
    // second run: entry matches → no add
    expect(await runInit(o)).toBe(0)
    expect(lines(fake.log).slice(2)).toEqual(["mcp get kitestring"])
  })

  it("removes and re-adds when the existing entry differs", async () => {
    useFixture("full")
    const fake = fakeClaude()
    writeFileSync(
      fake.state,
      "kitestring:\n  Scope: User config (available in all your projects)\n  Type: stdio\n  Command: /old/node\n  Args: /old/bin.js mcp\n  Environment:\n    KITE_SESSION=claude-code\n",
    )
    expect(await runInit(opts({ agents: ["claude-code"], env: { PATH: fake.dir } }))).toBe(0)
    const l = lines(fake.log)
    expect(l[0]).toBe("mcp get kitestring")
    expect(l[1]).toBe("mcp remove kitestring --scope user")
    expect(l[2]).toMatch(/^mcp add --transport stdio --scope user kitestring -e KITE_SESSION=claude-code -- /)
  })

  it("dry-run prints the commands without running add", async () => {
    useFixture("full")
    const fake = fakeClaude()
    expect(await runInit(opts({ agents: ["claude-code"], dryRun: true, env: { PATH: fake.dir } }))).toBe(0)
    expect(lines(fake.log).filter((l) => !l.startsWith("mcp get"))).toEqual([])
    expect(out.join("\n")).toContain("claude mcp add --transport stdio --scope user kitestring -e KITE_SESSION=claude-code --")
  })

  it("uninstall runs `claude mcp remove`", async () => {
    useFixture("full")
    const fake = fakeClaude()
    const o = opts({ agents: ["claude-code"], env: { PATH: fake.dir } })
    await runInit(o)
    expect(await runUninstall(o)).toBe(0)
    expect(lines(fake.log).at(-1)).toBe("mcp remove kitestring --scope user")
    expect(existsSync(fake.state)).toBe(false)
  })
})

describe("kite init CLI", () => {
  const cli = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [CLI_BIN, ...args], { encoding: "utf8", env, input: "" })

  it("non-TTY without --yes prints the plan and exits 2", () => {
    useFixture("full")
    const before = snapshot(home)
    const r = cli(["init"], { HOME: home, PATH: emptyBin, KITE_HOME: join(tmp, "kitehome") })
    expect(r.status, r.stderr).toBe(2)
    expect(r.stdout).toContain(join(home, ".cursor", "mcp.json"))
    expect(r.stderr).toMatch(/--yes/)
    expect(snapshot(home)).toEqual(before)
  })

  it("--yes --agents cursor works end to end against a temp HOME", () => {
    useFixture("full")
    const r = cli(["init", "--yes", "--agents", "cursor"], { HOME: home, PATH: emptyBin, KITE_HOME: join(tmp, "kitehome") })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(read(".cursor/mcp.json")).mcpServers.kitestring.command).toBe(resolveNode())
    expect(read(".codex/config.toml")).toBe(fixture("full", ".codex/config.toml"))
    const u = cli(["uninstall-agents", "--yes", "--agents", "cursor"], { HOME: home, PATH: emptyBin, KITE_HOME: join(tmp, "kitehome") })
    expect(u.status, u.stderr).toBe(0)
    expect(read(".cursor/mcp.json")).toBe(fixture("full", ".cursor/mcp.json"))
  })

  it("rejects an empty --agents list with exit 2", () => {
    useFixture("full")
    for (const v of ["", ","]) {
      const r = cli(["init", "--agents", v], { HOME: home, PATH: emptyBin, KITE_HOME: join(tmp, "kitehome") })
      expect(r.status, v).toBe(2)
      expect(r.stderr).toMatch(/--agents needs at least one/)
    }
  })

  it("rejects unknown agents with exit 2", () => {
    useFixture("full")
    const r = cli(["init", "--agents", "vim"], { HOME: home, PATH: emptyBin, KITE_HOME: join(tmp, "kitehome") })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/unknown agent/)
  })
})
