import { execFile } from "node:child_process"
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { EXTENSION_ID, HOST_NAME } from "@kitestring/protocol"
import { localAppData, tilde } from "../paths.js"
import { hostsDir, installHost, legacyNotices } from "../install/host-manifest.js"
import {
  AGENTS,
  CODEX_TABLE,
  SERVER_NAME,
  claudeAddArgv,
  claudeEntry,
  claudeGetArgv,
  claudeRemoveArgv,
  codexBlock,
  cursorEntry,
  geminiEntry,
  opencodeEntry,
  type AgentId,
  type Launch,
} from "./agents.js"
import { detect, type DetectedAgent } from "./detect.js"
import { jsonGet, jsonRemove, jsonSet } from "./json-edit.js"
import { nodeCandidates, resolveNode } from "./node-path.js"
import { isExecutableFile, isOurShim, onPath, pathLine, shimCmdScript, shimDir, shimPath, shimScript } from "../install/shim.js"
import { SKILL_NAMES, agentsSkillsDir, claudeSkillsDir, linkState, pointsInto, repoSkillsDir, sameTree } from "./skills.js"
import { tomlRemoveTable, tomlSetTable } from "./toml-edit.js"

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface InitOptions {
  /** Home dir; every agent/skills path derives from it. */
  home: string
  /** Environment used for PATH lookup of `claude`, its child env, and KITE_HOME. */
  env: NodeJS.ProcessEnv
  agents?: AgentId[]
  dryRun?: boolean
  yes?: boolean
  /** Whether stdin/stdout is a terminal (prompt allowed). */
  tty?: boolean
  confirm?: (question: string) => Promise<boolean>
  out: (line: string) => void
  /** Default process.platform; injectable so the win32 paths are testable anywhere. */
  platform?: NodeJS.Platform
  /** Where to print the "re-run with --yes" hint (default: out). */
  err?: (line: string) => void
  /** Node binary for MCP entries (default resolveNode()). */
  node?: string
  /** Absolute path of packages/cli/dist/bin.js (default: resolved from this file). */
  bin?: string
  /** Node candidates for the `$KITE_HOME/bin/kite` shim (default nodeCandidates()). */
  shimNodes?: string[]
  skillsDir?: string
  /** Is the extension connected (status RPC)? Default false-on-error check via the socket. */
  isConnected?: () => Promise<boolean>
  now?: Date
  exec?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<ExecResult>
}

type Step =
  | { kind: "edit"; agent: string; path: string; transform: (text: string) => string; create: boolean; what: string }
  | { kind: "exec"; agent: string; file: string; argv: string[]; what: string }
  /** Replace `to` with a copy of `from`; a modified `to` is first moved to `backupTo`. */
  | { kind: "copy"; agent: string; from: string; to: string; backupTo?: string; what: string }
  | { kind: "remove"; agent: string; path: string; what: string }
  | { kind: "symlink"; agent: string; path: string; target: string; what: string }
  /** Write an executable file (the CLI shim). */
  | { kind: "write"; agent: string; path: string; text: string; what: string }

interface Plan {
  steps: Step[]
  notes: string[]
  problems: string[]
}

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const REPO_ROOT = join(PKG_ROOT, "..", "..")
export const DEFAULT_BIN = join(PKG_ROOT, "dist", "bin.js")
export const EXTENSION_BUILD = join(REPO_ROOT, "packages", "extension", "build", "chrome-mv3-prod")

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function defaultExec(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 60_000, encoding: "utf8" }, (err, stdout, stderr) => {
      const exit = (err as { code?: unknown } | null)?.code
      const code = err ? (typeof exit === "number" ? exit : 1) : 0
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) })
    })
  })
}

async function defaultIsConnected(): Promise<boolean> {
  const { call } = await import("../client/rpc-client.js")
  try {
    await call("status", {}, { session: "default", timeoutMs: 2000 })
    return true
  } catch {
    return false
  }
}

/** First executable `claude` on the given PATH. */
export function findOnPath(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    try {
      accessSync(p, constants.X_OK)
      if (statSync(p).isFile()) return p
    } catch {}
  }
  return undefined
}

const isSymlink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** Backups of replaced skill folders live outside every skills dir, e.g. ~/.agents/kite-backups/skills/<name>.kite-backup-<stamp>. */
export function skillBackupPath(home: string, name: string, now: Date): string {
  const base = join(home, ".agents", "kite-backups", "skills", `${name}.kite-backup-${stamp(now)}`)
  let p = base
  for (let n = 1; existsSync(p); n++) p = `${base}.${n}`
  return p
}

const readOrNull = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null)
const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

interface ClaudeGet {
  found: boolean
  userScope: boolean
  command?: string
  args?: string
  env: string[]
}

/** Parses `claude mcp get <name>` human output (Scope/Command/Args/Environment lines). */
export function parseClaudeGet(r: ExecResult): ClaudeGet {
  if (r.code !== 0) return { found: false, userScope: false, env: [] }
  const lines = r.stdout.split("\n")
  const field = (k: string) => lines.find((l) => l.trim().startsWith(k + ":"))?.trim().slice(k.length + 1).trim()
  const envStart = lines.findIndex((l) => l.trim() === "Environment:")
  const env: string[] = []
  if (envStart >= 0) for (const l of lines.slice(envStart + 1)) if (/^\s+\S+=/.test(l)) env.push(l.trim()); else if (l.trim()) break
  return { found: true, userScope: /^user/i.test(field("Scope") ?? ""), command: field("Command"), args: field("Args"), env }
}

interface Ctx {
  o: InitOptions
  launch: Launch
  claude?: string
  exec: NonNullable<InitOptions["exec"]>
  plan: Plan
  now: Date
}

function editStep(ctx: Ctx, agent: string, path: string, transform: (t: string) => string, create: boolean, label: string): void {
  const before = readOrNull(path)
  if (before === null && !create) {
    ctx.plan.notes.push(`${agent}: ${tilde(ctx.o.home, path)} not found — nothing to do`)
    return
  }
  let after: string
  try {
    after = transform(before ?? "")
  } catch (e) {
    ctx.plan.problems.push(`${agent}: ${path}: ${(e as Error).message}`)
    return
  }
  if (after === (before ?? "")) {
    ctx.plan.notes.push(`${agent}: up to date (${tilde(ctx.o.home, path)})`)
    return
  }
  ctx.plan.steps.push({ kind: "edit", agent, path, transform, create: before === null, what: `${label} ${path}` })
}

async function planClaude(ctx: Ctx, a: DetectedAgent, install: boolean): Promise<void> {
  const { o } = ctx
  if (ctx.claude) {
    const got = parseClaudeGet(await ctx.exec(ctx.claude, claudeGetArgv(), o.env))
    const args = `${ctx.launch.bin} mcp`
    const matches = got.found && got.userScope && got.command === ctx.launch.node && got.args === args && got.env.includes("KITE_SESSION=claude-code")
    const cmd = (argv: string[]) => `claude ${argv.map(shellQuote).join(" ")}`
    const exec = (argv: string[]): Step => ({ kind: "exec", agent: a.id, file: ctx.claude!, argv, what: `run ${cmd(argv)}` })
    if (install) {
      if (matches) return void ctx.plan.notes.push(`${a.id}: up to date (claude mcp get ${SERVER_NAME})`)
      if (got.found && got.userScope) ctx.plan.steps.push(exec(claudeRemoveArgv()))
      ctx.plan.steps.push(exec(claudeAddArgv(ctx.launch)))
    } else {
      if (got.found && got.userScope) ctx.plan.steps.push(exec(claudeRemoveArgv()))
      else ctx.plan.notes.push(`${a.id}: no user-scope ${SERVER_NAME} server registered — nothing to do`)
    }
    return
  }
  const file = join(o.home, ".claude.json")
  const path = ["mcpServers", SERVER_NAME]
  if (install) editStep(ctx, a.id, file, (t) => jsonSet(t, path, claudeEntry(ctx.launch)), true, "set mcpServers.kitestring in")
  else editStep(ctx, a.id, file, (t) => jsonRemove(t, path), false, "remove mcpServers.kitestring from")
}

function planFileAgent(ctx: Ctx, a: DetectedAgent, install: boolean): void {
  const { launch } = ctx
  switch (a.id) {
    case "codex": {
      const f = join(a.configDir, "config.toml")
      if (install) editStep(ctx, a.id, f, (t) => tomlSetTable(t, CODEX_TABLE, codexBlock(launch)), true, `set [${CODEX_TABLE}] in`)
      else editStep(ctx, a.id, f, (t) => tomlRemoveTable(t, CODEX_TABLE), false, `remove [${CODEX_TABLE}] from`)
      return
    }
    case "cursor": {
      const f = join(a.configDir, "mcp.json")
      if (install) editStep(ctx, a.id, f, (t) => jsonSet(t, ["mcpServers", SERVER_NAME], cursorEntry(launch)), true, "set mcpServers.kitestring in")
      else editStep(ctx, a.id, f, (t) => jsonRemove(t, ["mcpServers", SERVER_NAME]), false, "remove mcpServers.kitestring from")
      return
    }
    case "gemini": {
      const f = join(a.configDir, "settings.json")
      if (install) editStep(ctx, a.id, f, (t) => jsonSet(t, ["mcpServers", SERVER_NAME], geminiEntry(launch)), true, "set mcpServers.kitestring in")
      else editStep(ctx, a.id, f, (t) => jsonRemove(t, ["mcpServers", SERVER_NAME]), false, "remove mcpServers.kitestring from")
      return
    }
    case "opencode": {
      const jsonc = join(a.configDir, "opencode.jsonc")
      const json = join(a.configDir, "opencode.json")
      if (install) {
        const f = existsSync(jsonc) ? jsonc : json
        editStep(ctx, a.id, f, (t) => jsonSet(t, ["mcp", SERVER_NAME], opencodeEntry(launch)), true, "set mcp.kitestring in")
      } else {
        let any = false
        for (const f of [jsonc, json]) {
          const t = readOrNull(f)
          let has = t !== null
          try {
            has = has && jsonGet(t!, ["mcp", SERVER_NAME]) !== undefined
          } catch {} // unparseable: let editStep report it
          if (has) {
            any = true
            editStep(ctx, a.id, f, (x) => jsonRemove(x, ["mcp", SERVER_NAME]), false, "remove mcp.kitestring from")
          }
        }
        if (!any) ctx.plan.notes.push(`${a.id}: no ${SERVER_NAME} entry — nothing to do`)
      }
      return
    }
  }
}

function planSkills(ctx: Ctx, install: boolean, sharedSkills: boolean, claudeLinks: boolean): void {
  const { o, plan } = ctx
  const src = o.skillsDir ?? repoSkillsDir()
  const shared = agentsSkillsDir(o.home)
  const links = claudeSkillsDir(o.home)
  for (const name of SKILL_NAMES) {
    const from = join(src, name)
    const to = join(shared, name)
    const link = join(links, name)
    if (install) {
      if (!existsSync(join(from, "SKILL.md"))) {
        plan.problems.push(`skills: ${from}/SKILL.md missing — skill ${name} not installed`)
        continue
      }
      if (sameTree(from, to)) plan.notes.push(`skills: ${tilde(o.home, to)} up to date`)
      else if (existsSync(to) || isSymlink(to)) {
        // Differs from the repo copy (user-edited, or an older version): keep it, outside any skills dir
        // (a second folder with the same `name` under ~/.agents/skills would clash in OpenCode/Codex).
        const backupTo = skillBackupPath(o.home, name, ctx.now)
        plan.steps.push({
          kind: "copy",
          agent: "skills",
          from,
          to,
          backupTo,
          what: `replace modified ${to} with ${from} (existing folder moved to ${backupTo})`,
        })
      } else plan.steps.push({ kind: "copy", agent: "skills", from, to, what: `copy ${from} → ${to}` })
      if (!claudeLinks) continue
      const state = linkState(link, to)
      if (state === "ours") plan.notes.push(`skills: ${tilde(o.home, link)} → ${tilde(o.home, to)} up to date`)
      else if (state === "not-symlink") plan.problems.push(`skills: ${link} is not a symlink — left alone (remove it and re-run to link ${to})`)
      else plan.steps.push({ kind: "symlink", agent: "skills", path: link, target: to, what: `symlink ${link} → ${to}` })
    } else {
      if (claudeLinks) {
        if (pointsInto(link, shared)) plan.steps.push({ kind: "remove", agent: "skills", path: link, what: `remove symlink ${link}` })
        else if (linkState(link, to) !== "missing") plan.notes.push(`skills: ${tilde(o.home, link)} is not our symlink — left alone`)
      }
      if (!sharedSkills || !(existsSync(to) || isSymlink(to))) continue
      // Only remove what init put there: an exact copy of the repo skill.
      if (existsSync(join(from, "SKILL.md")) && sameTree(from, to)) {
        plan.steps.push({ kind: "remove", agent: "skills", path: to, what: `remove ${to}` })
      } else plan.notes.push(`skills: ${tilde(o.home, to)} differs from ${from} (modified) — left alone`)
    }
  }
}

/** `$KITE_HOME/bin/kite`: install or refresh it; on a full uninstall remove it (only if it is ours). */
function planShim(ctx: Ctx, install: boolean): void {
  const { o, plan } = ctx
  const win = (o.platform ?? process.platform) === "win32"
  const path = shimPath(kiteHomeOf(o), o.platform, localAppData(o.env, o.home))
  if (install) {
    const nodes = o.shimNodes ?? nodeCandidates()
    const text =
      win ? shimCmdScript(kiteHomeOf(o), nodes[0]!, ctx.launch.bin) : shimScript(kiteHomeOf(o), nodes, ctx.launch.bin)
    if (readOrNull(path) === text && isExecutableFile(path)) plan.notes.push(`cli: ${tilde(o.home, path)} up to date`)
    else plan.steps.push({ kind: "write", agent: "cli", path, text, what: `write ${path} (runs kite)` })
  } else if (existsSync(path)) {
    if (isOurShim(path)) plan.steps.push({ kind: "remove", agent: "cli", path, what: `remove ${path}` })
    else plan.notes.push(`cli: ${tilde(o.home, path)} was not written by kite init — left alone`)
  }
}

async function buildPlan(o: InitOptions, install: boolean): Promise<{ ctx: Ctx; selected: DetectedAgent[] }> {
  const launch: Launch = { node: o.node ?? resolveNode(), bin: o.bin ?? DEFAULT_BIN }
  const ctx: Ctx = {
    o,
    launch,
    claude: findOnPath("claude", o.env.PATH),
    exec: o.exec ?? defaultExec,
    plan: { steps: [], notes: [], problems: [] },
    now: o.now ?? new Date(),
  }
  const wanted = new Set<AgentId>(o.agents ?? AGENTS)
  const selected: DetectedAgent[] = []
  for (const a of detect(o.home)) {
    if (!wanted.has(a.id)) continue
    if (!a.present) {
      ctx.plan.notes.push(`${a.id}: not installed (no ${a.display}) — skipped`)
      continue
    }
    selected.push(a)
    if (a.id === "claude-code") await planClaude(ctx, a, install)
    else planFileAgent(ctx, a, install)
  }
  const claudeLinks = selected.some((a) => a.id === "claude-code")
  if (install) {
    if (selected.length > 0) planSkills(ctx, true, true, claudeLinks)
    planShim(ctx, true)
  } else {
    // Shared skills and the CLI shim serve every agent: only remove them when uninstalling all agents.
    planSkills(ctx, false, o.agents === undefined, claudeLinks)
    if (o.agents === undefined) planShim(ctx, false)
  }
  return { ctx, selected }
}

function printPlan(o: InitOptions, plan: Plan, title: string): void {
  o.out(title)
  for (const n of plan.notes) o.out(n)
  for (const s of plan.steps) o.out(`${s.agent}: ${s.what}`)
  for (const p of plan.problems) o.out(`${p}`)
  if (plan.steps.length === 0) o.out("Everything is up to date.")
}

async function confirmed(o: InitOptions): Promise<number | undefined> {
  if (o.yes) return undefined
  if (!o.tty || !o.confirm) {
    ;(o.err ?? o.out)("not a terminal — re-run with --yes to apply this plan")
    return 2
  }
  return (await o.confirm("Proceed? [y/N] ")) ? undefined : 1
}

/** Write `text` to `path` atomically (temp + rename), following a symlinked config to its real file. */
function atomicWrite(path: string, text: string): void {
  const real = existsSync(path) ? realpathSync(path) : path
  // Keep an existing file's mode; files we create are private (agent configs can hold secrets).
  const mode = existsSync(real) ? statSync(real).mode & 0o7777 : 0o600
  const tmp = `${real}.kite-tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  try {
    chmodSync(tmp, mode) // explicit: writeFileSync's mode is filtered by the umask
    renameSync(tmp, real)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

async function applyPlan(ctx: Ctx): Promise<string[]> {
  const { o, plan, now } = ctx
  const failures: string[] = []
  let done = 0
  const backedUp = new Set<string>()
  const backup = (path: string) => {
    if (backedUp.has(path) || !existsSync(path)) return
    // One backup per file per run; a second run within the same second gets a numeric suffix.
    let b = `${path}.kite-backup-${stamp(now)}`
    for (let n = 1; existsSync(b); n++) b = `${path}.kite-backup-${stamp(now)}.${n}`
    copyFileSync(path, b)
    backedUp.add(path)
    o.out(`backup: ${b}`)
  }
  for (const s of plan.steps) {
    try {
      switch (s.kind) {
        case "edit": {
          // Re-read at apply time (e.g. ~/.claude.json is rewritten by the running app) and re-apply.
          const before = readOrNull(s.path)
          if (before === null && !s.create) break
          const after = s.transform(before ?? "")
          if (after === (before ?? "")) break
          backup(s.path)
          atomicWrite(s.path, after)
          break
        }
        case "exec": {
          const r = await ctx.exec(s.file, s.argv, o.env)
          if (r.code !== 0) throw new Error(`claude ${s.argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`)
          break
        }
        case "copy":
          if (s.backupTo && (existsSync(s.to) || isSymlink(s.to))) {
            mkdirSync(dirname(s.backupTo), { recursive: true })
            renameSync(s.to, s.backupTo)
            o.out(`backup: ${s.backupTo}`)
          }
          rmSync(s.to, { recursive: true, force: true })
          mkdirSync(dirname(s.to), { recursive: true })
          cpSync(s.from, s.to, { recursive: true })
          break
        case "remove":
          if (lstatSync(s.path).isSymbolicLink()) unlinkSync(s.path)
          else rmSync(s.path, { recursive: true, force: true })
          break
        case "write": {
          mkdirSync(dirname(s.path), { recursive: true })
          const tmp = `${s.path}.kite-tmp-${process.pid}`
          writeFileSync(tmp, s.text)
          try {
            chmodSync(tmp, 0o755)
            renameSync(tmp, s.path)
          } catch (e) {
            rmSync(tmp, { force: true })
            throw e
          }
          break
        }
        case "symlink":
          mkdirSync(dirname(s.path), { recursive: true })
          if (linkState(s.path, s.target) === "other-symlink") unlinkSync(s.path)
          symlinkSync(s.target, s.path)
          break
      }
      done++
    } catch (e) {
      failures.push(`${s.agent}: FAILED — ${s.what}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  for (const f of failures) o.out(f)
  if (plan.steps.length) o.out(`Applied ${done} of ${plan.steps.length} change(s).`)
  return failures
}

function kiteHomeOf(o: InitOptions): string {
  return o.env.KITE_HOME || join(o.home, ".kitestring")
}

/** When `$KITE_HOME/bin` is not on PATH: the exact line to add to the shell profile (never edited for you). */
function printPathHint(o: InitOptions): void {
  const kh = kiteHomeOf(o)
  const plat = o.platform ?? process.platform
  const lad = localAppData(o.env, o.home)
  if (onPath(shimDir(kh, plat, lad), o.env.PATH)) return
  o.out("")
  if (plat === "win32") o.out(`cli: ${shimDir(kh, plat, lad)} is not on your PATH. To run \`kite\` from any shell or agent, add it to your user PATH, e.g. in cmd.exe:`)
  else o.out(`cli: ${shimDir(kh)} is not on your PATH. To run \`kite\` from any shell or agent, add this line to your shell profile (~/.zshrc, ~/.bashrc, …):`)
  o.out(`  ${pathLine(o.home, kh, plat, lad)}`)
}

export async function runInit(o: InitOptions): Promise<number> {
  const { ctx, selected } = await buildPlan(o, true)
  const { plan } = ctx
  const manifest = join(hostsDir({ browser: "chrome", home: o.home, platform: o.platform, localAppData: localAppData(o.env, o.home) }), `${HOST_NAME}.json`)
  printPlan(o, plan, o.dryRun ? "kite init — dry run (nothing will be written):" : "kite init — plan:")
  o.out(`host: install native host manifest ${manifest}`)
  if (selected.length === 0) o.out("No supported agents found (looked for ~/.claude, ~/.codex, ~/.cursor, ~/.gemini, ~/.config/opencode).")
  if (o.dryRun) {
    printPathHint(o)
    return plan.problems.length ? 1 : 0
  }
  const stop = await confirmed(o)
  if (stop !== undefined) return stop

  const failures = await applyPlan(ctx)
  try {
    const r = installHost({ browser: "chrome", extensionId: EXTENSION_ID, kiteHome: kiteHomeOf(o), home: o.home, platform: o.platform, localAppData: localAppData(o.env, o.home) })
    o.out(`host: native host manifest ${r.manifestPath}`)
    for (const line of legacyNotices(r, o.home)) o.out(`host: ${line}`)
  } catch (e) {
    failures.push(`host: FAILED — ${e instanceof Error ? e.message : String(e)}`)
    o.out(failures[failures.length - 1]!)
  }

  if (await (o.isConnected ?? defaultIsConnected)()) {
    o.out("Extension connected — you're set. Restart your agents to pick up the kitestring MCP server.")
  } else {
    o.out("")
    o.out("Load the Kitestring extension in Chrome:")
    o.out("  1. Open chrome://extensions and turn on Developer mode")
    o.out(`  2. Click "Load unpacked" and choose ${EXTENSION_BUILD}`)
    o.out(`  3. Check the extension ID is ${EXTENSION_ID}`)
    o.out("Then restart your agents to pick up the kitestring MCP server.")
  }
  printPathHint(o)
  return failures.length || plan.problems.length ? 1 : 0
}

export async function runUninstall(o: InitOptions): Promise<number> {
  const { ctx } = await buildPlan(o, false)
  const { plan } = ctx
  printPlan(o, plan, o.dryRun ? "kite uninstall-agents — dry run (nothing will be written):" : "kite uninstall-agents — plan:")
  o.out("host: native host manifest kept — it belongs to `kite install-host`")
  if (o.dryRun) return plan.problems.length ? 1 : 0
  const stop = await confirmed(o)
  if (stop !== undefined) return stop
  const failures = await applyPlan(ctx)
  return failures.length || plan.problems.length ? 1 : 0
}
