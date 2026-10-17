import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { TOOL_NAMES } from "../src/mcp/tools.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, "..", "dist", "bin.js")
const SKILLS = join(HERE, "..", "..", "..", "skills")
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function help(args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args, "--help"], { encoding: "utf8" })
  expect(r.status, `kite ${args.join(" ")} --help failed: ${r.stderr}`).toBe(0)
  return r.stdout
}

/** Command names listed under "Commands:" (wrapped description lines are indented deeper and skipped). */
function commandsOf(text: string): Set<string> {
  const section = text.split(/^Commands:$/m)[1] ?? ""
  const names = new Set<string>()
  for (const line of section.split("\n")) {
    const m = /^ {2}([a-z][a-z-]*)\b/.exec(line)
    if (m && m[1] !== "help") names.add(m[1]!)
  }
  return names
}

const flagsOf = (text: string): Set<string> => new Set((text.split(/^Commands:$/m)[0]!.match(/--[a-z][a-z-]*/g) ?? []))

function mdFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...mdFiles(p))
    else if (e.endsWith(".md")) out.push(p)
  }
  return out
}

/** `kite …` invocations: inline code spans and lines of fenced code blocks. */
function kiteMentions(md: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      const m = /^\s*(?:\$\s+)?(kite\s.*)$/.exec(line)
      if (m) out.push(m[1]!.replace(/\s+#.*$/, ""))
      continue
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) if (/^kite\s/.test(m[1]!)) out.push(m[1]!)
  }
  return out
}

function skillDirs(): string[] {
  return readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory())
}

describe("skills pack", () => {
  it("has the three Kitestring skills", () => {
    expect(existsSync(SKILLS)).toBe(true)
    expect(skillDirs().sort()).toEqual(expect.arrayContaining(["kitestring", "kitestring-debug-frontend", "kitestring-e2e-verify"]))
  })

  it("every SKILL.md has exactly name + description, valid name equal to its folder, description ≤ 1024 chars", () => {
    for (const dir of skillDirs()) {
      const file = join(SKILLS, dir, "SKILL.md")
      expect(existsSync(file), `${dir}/SKILL.md`).toBe(true)
      const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, "utf8"))
      expect(m, `${dir}: frontmatter`).not.toBeNull()
      const fields: Record<string, string> = {}
      for (const line of m![1]!.split("\n")) {
        const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
        expect(kv, `${dir}: frontmatter line must be "key: value" on one line: ${line}`).not.toBeNull()
        fields[kv![1]!] = kv![2]!.replace(/^(["'])(.*)\1$/, "$2")
      }
      expect(Object.keys(fields).sort(), dir).toEqual(["description", "name"])
      expect(fields.name, dir).toMatch(NAME_RE)
      expect(fields.name).toBe(dir)
      expect(fields.description!.length, `${dir}: description`).toBeGreaterThan(0)
      expect(fields.description!.length, `${dir}: description`).toBeLessThanOrEqual(1024)
    }
  })

  it("every `kite …` mentioned is a real command with real flags", () => {
    const top = help([])
    const globalFlags = flagsOf(top)
    const commands = commandsOf(top)
    const tabCommands = commandsOf(help(["tab"]))
    const cmdHelp = new Map<string, string>()
    let checked = 0
    for (const file of mdFiles(SKILLS)) {
      const where = relative(SKILLS, file)
      for (const mention of kiteMentions(readFileSync(file, "utf8"))) {
        const toks = mention.trim().split(/\s+/).slice(1)
        // skip leading global options
        while (toks[0] === "--json" || toks[0] === "--session") toks.splice(0, toks[0] === "--session" ? 2 : 1)
        const cmd = toks[0]
        if (cmd === undefined) continue // bare `kite`
        expect(commands.has(cmd), `${where}: \`${mention}\` — no command "${cmd}"`).toBe(true)
        let path = [cmd]
        if (cmd === "tab") {
          expect(tabCommands.has(toks[1] ?? ""), `${where}: \`${mention}\` — no tab subcommand "${toks[1]}"`).toBe(true)
          path = ["tab", toks[1]!]
        }
        const key = path.join(" ")
        if (!cmdHelp.has(key)) cmdHelp.set(key, help(path))
        const flags = flagsOf(cmdHelp.get(key)!)
        for (const t of toks) {
          if (!t.startsWith("--")) continue
          const flag = t.replace(/=.*$/, "")
          expect(flags.has(flag) || globalFlags.has(flag), `${where}: \`${mention}\` — no flag ${flag} on kite ${key}`).toBe(true)
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(10)
  })

  it("every browser_* tool mentioned exists in the MCP server", () => {
    const known = new Set(TOOL_NAMES)
    let checked = 0
    for (const file of mdFiles(SKILLS)) {
      for (const m of readFileSync(file, "utf8").matchAll(/\bbrowser_[a-z_]+\b/g)) {
        expect(known.has(m[0]), `${relative(SKILLS, file)}: unknown MCP tool ${m[0]}`).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(10)
  })
})
