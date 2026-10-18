import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { EXTENSION_ID, HOST_NAME, LEGACY_HOST_NAMES } from "@kitestring/protocol"
import { KiteError, call } from "../client/rpc-client.js"
import { localAppData, socketPath, tilde } from "../paths.js"
import { isPipePath } from "../host/daemon.js"
import { allowedOrigins, hostWrapperName, hostsDir } from "../install/host-manifest.js"
import { SERVER_NAME, claudeGetArgv, type AgentId } from "../init/agents.js"
import { detect } from "../init/detect.js"
import { EXTENSION_BUILD, defaultExec, findOnPath, parseClaudeGet, type ExecResult } from "../init/init.js"
import { jsonGet } from "../init/json-edit.js"
import { SKILL_NAMES, agentsSkillsDir, claudeSkillsDir, linkState } from "../init/skills.js"
import { tomlHasTable } from "../init/toml-edit.js"
import { isExecutableFile, onPath, pathLine, shimDir, shimPath } from "../install/shim.js"

export interface Check {
  id: string
  ok: boolean
  detail: string
  fix?: string
}

export interface DoctorOptions {
  /** Home dir; every path derives from it (never the real home in tests). */
  home: string
  env: NodeJS.ProcessEnv
  /** Default process.versions.node. */
  nodeVersion?: string
  exec?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<ExecResult>
  /** Default process.platform; injectable so the win32 paths are testable anywhere. */
  platform?: NodeJS.Platform
}

const MIN_NODE = [22, 12, 0]
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

function nodeOk(v: string): boolean {
  const p = v.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const a = p[i] ?? 0
    if (a !== MIN_NODE[i]) return a > MIN_NODE[i]!
  }
  return true
}

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function readJson(p: string): any {
  return JSON.parse(readFileSync(p, "utf8"))
}

function checkManifest(o: DoctorOptions, dir: string, wrapper: string): Check {
  const id = "host-manifest"
  const file = join(dir, `${HOST_NAME}.json`)
  const fix = "run `kite install-host` (or `kite init`)"
  const legacy = LEGACY_HOST_NAMES.map((n) => join(dir, `${n}.json`)).filter(existsSync)
  if (!existsSync(file)) return { id, ok: false, detail: `${tilde(o.home, file)} not found`, fix }
  const problems: string[] = []
  try {
    const m = readJson(file)
    if (m.name !== HOST_NAME) problems.push(`name is ${JSON.stringify(m.name)}, expected ${HOST_NAME}`)
    if (m.path !== wrapper) problems.push(`path is ${JSON.stringify(m.path)}, expected ${wrapper}`)
    const origins = JSON.stringify(m.allowed_origins)
    if (origins !== JSON.stringify(allowedOrigins(EXTENSION_ID))) problems.push(`allowed_origins is ${origins}, expected the Kitestring extension ${EXTENSION_ID}`)
  } catch (e) {
    problems.push(`unreadable: ${msg(e)}`)
  }
  for (const l of legacy) problems.push(`legacy manifest ${tilde(o.home, l)} still present (old bx install)`)
  if (problems.length) return { id, ok: false, detail: problems.join("; "), fix }
  return { id, ok: true, detail: tilde(o.home, file) }
}

function checkWrapper(o: DoctorOptions, wrapper: string): Check {
  const id = "host-wrapper"
  const fix = "run `kite install-host` (or `kite init`)"
  if (!existsSync(wrapper)) return { id, ok: false, detail: `${tilde(o.home, wrapper)} not found`, fix }
  if (!wrapper.endsWith(".cmd") && !isExecutable(wrapper)) return { id, ok: false, detail: `${tilde(o.home, wrapper)} is not executable`, fix }
  const text = readFileSync(wrapper, "utf8")
  if (wrapper.endsWith(".cmd")) {
    const node = /^"([^"]*)" "[^"]*" %\*\r?$/m.exec(text)?.[1]
    if (!node) return { id, ok: false, detail: "wrapper names no node", fix }
    if (!existsSync(node)) return { id, ok: false, detail: `node ${node} does not exist`, fix }
    return { id, ok: true, detail: `${tilde(o.home, wrapper)}, node ${node}` }
  }
  const list = /^for n in (.*); do$/m.exec(text)?.[1] ?? ""
  const nodes = [...list.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1]!.replace(/'\\''/g, "'"))
  const live = nodes.filter(isExecutable)
  if (live.length === 0) {
    return { id, ok: false, detail: nodes.length ? `none of the node candidates exist: ${nodes.join(", ")}` : "wrapper lists no node candidates", fix }
  }
  return { id, ok: true, detail: `${tilde(o.home, wrapper)}, node ${live[0]}` }
}

async function checkBridge(sock: string): Promise<{ bridge: Check; extension: Check }> {
  const loadExt = `load or reload the Kitestring extension in Chrome (chrome://extensions → Load unpacked → ${EXTENSION_BUILD})`
  const down = (bridge: Check): { bridge: Check; extension: Check } => ({
    bridge,
    extension: { id: "extension", ok: false, detail: "not checked — bridge unreachable", fix: bridge.fix },
  })
  if (!isPipePath(sock) && !existsSync(sock)) {
    return down({ id: "bridge", ok: false, detail: `no socket at ${sock} — the host never started`, fix: `host never started — ${loadExt}` })
  }
  let status: unknown
  try {
    status = await call("status", {}, { session: "doctor", timeoutMs: 2000, socketPath: sock })
  } catch (e) {
    if (e instanceof KiteError && e.code === "NOT_CONNECTED" && !e.connected) {
      return down({ id: "bridge", ok: false, detail: `socket ${sock} exists but nothing answers`, fix: "socket stale — reload the extension in Chrome (chrome://extensions)" })
    }
    return {
      bridge: { id: "bridge", ok: true, detail: `socket ${sock} reachable` },
      extension: { id: "extension", ok: false, detail: e instanceof KiteError && e.code === "NOT_CONNECTED" ? `host is running but the extension is not connected (${e.message})` : `status failed: ${msg(e)}`, fix: "reload the extension in Chrome (chrome://extensions)" },
    }
  }
  const connected = !!status && typeof status === "object" && (status as { connected?: unknown }).connected === true
  return {
    bridge: { id: "bridge", ok: true, detail: `socket ${sock} reachable` },
    extension: connected
      ? { id: "extension", ok: true, detail: "connected" }
      : { id: "extension", ok: false, detail: "status reports the extension is not connected", fix: "reload the Kitestring extension in Chrome (chrome://extensions)" },
  }
}

const initFix = "run `kite init`"

/** `$KITE_HOME/bin/kite` (written by kite init) exists and runs; whether it is on PATH is only reported. */
function checkCli(o: DoctorOptions, kiteHome: string): Check {
  const id = "cli"
  const plat = o.platform ?? process.platform
  const lad = localAppData(o.env, o.home)
  const shim = shimPath(kiteHome, plat, lad)
  const line = pathLine(o.home, kiteHome, plat, lad)
  const where = tilde(o.home, shim)
  if (!existsSync(shim)) return { id, ok: false, detail: `${where} not found`, fix: `${initFix}, then ${plat === "win32" ? "run" : "add"} \`${line}\`${plat === "win32" ? "" : " to your shell profile"}` }
  if (!isExecutableFile(shim)) return { id, ok: false, detail: `${where} is not executable`, fix: `${initFix} (rewrites it)` }
  const on = onPath(shimDir(kiteHome, plat, lad), o.env.PATH)
  return { id, ok: true, detail: on ? `${where} (on PATH)` : `${where} (not on PATH — ${plat === "win32" ? "run" : "add"} \`${line}\`${plat === "win32" ? "" : " to your shell profile"})` }
}

/** Reads the launch args (bin.js path) that agent `id`'s config has for our MCP server; undefined = no entry. */
interface McpEntry {
  bin?: string
  where: string
  error?: string
  /** No kitestring entry at all (as opposed to a broken one): the agent is not registered. */
  missing?: boolean
}

async function mcpBin(o: DoctorOptions, id: AgentId, dir: string): Promise<McpEntry> {
  const json = (file: string, path: string[], pick: (v: any) => unknown) => {
    if (!existsSync(file)) return { where: tilde(o.home, file), error: `${tilde(o.home, file)} not found`, missing: true }
    try {
      const v = jsonGet(readFileSync(file, "utf8"), path)
      if (v === undefined) return { where: tilde(o.home, file), error: `no ${path.join(".")} entry in ${tilde(o.home, file)}`, missing: true }
      const bin = pick(v)
      return typeof bin === "string" ? { where: tilde(o.home, file), bin } : { where: tilde(o.home, file), error: `${path.join(".")} in ${tilde(o.home, file)} has no launch path` }
    } catch (e) {
      return { where: tilde(o.home, file), error: `${tilde(o.home, file)}: ${msg(e)}` }
    }
  }
  switch (id) {
    case "claude-code": {
      const claude = findOnPath("claude", o.env.PATH)
      if (claude) {
        const got = parseClaudeGet(await (o.exec ?? defaultExec)(claude, claudeGetArgv(), o.env))
        if (!got.found) return { where: "claude mcp get", error: `claude mcp get ${SERVER_NAME}: no such server`, missing: true }
        const bin = got.args?.replace(/\s+mcp$/, "")
        return bin ? { where: "claude mcp get", bin } : { where: "claude mcp get", error: "claude mcp get shows no args" }
      }
      return json(join(o.home, ".claude.json"), ["mcpServers", SERVER_NAME], (v) => v.args?.[0])
    }
    case "codex": {
      const file = join(dir, "config.toml")
      const where = tilde(o.home, file)
      if (!existsSync(file)) return { where, error: `${where} not found`, missing: true }
      const text = readFileSync(file, "utf8")
      if (!tomlHasTable(text, `mcp_servers.${SERVER_NAME}`)) return { where, error: `no [mcp_servers.${SERVER_NAME}] in ${where}`, missing: true }
      // The table's own lines: from its header to the next table header.
      const start = text.search(new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]\\s*$`, "m"))
      const rest = start < 0 ? "" : text.slice(start).split("\n").slice(1).join("\n")
      const body = rest.split(/^\[/m)[0]!
      const m = /^args\s*=\s*\[\s*("(?:[^"\\]|\\.)*")/m.exec(body)
      try {
        return m ? { where, bin: JSON.parse(m[1]!) as string } : { where, error: `[mcp_servers.${SERVER_NAME}] in ${where} has no args` }
      } catch {
        return { where, error: `[mcp_servers.${SERVER_NAME}] in ${where} has unreadable args` }
      }
    }
    case "cursor":
      return json(join(dir, "mcp.json"), ["mcpServers", SERVER_NAME], (v) => v.args?.[0])
    case "gemini":
      return json(join(dir, "settings.json"), ["mcpServers", SERVER_NAME], (v) => v.args?.[0])
    case "opencode": {
      const jsonc = join(dir, "opencode.jsonc")
      const file = existsSync(jsonc) ? jsonc : join(dir, "opencode.json")
      return json(file, ["mcp", SERVER_NAME], (v) => v.command?.[1])
    }
  }
}

function checkMcp(id: AgentId, r: McpEntry): Check {
  const cid = `mcp:${id}`
  if (r.error || !r.bin) return { id: cid, ok: false, detail: r.error ?? "no entry", fix: initFix }
  if (!existsSync(r.bin)) return { id: cid, ok: false, detail: `${r.where} points at ${r.bin}, which does not exist`, fix: `${initFix} (re-registers with the current install path)` }
  return { id: cid, ok: true, detail: `${r.where} → ${r.bin}` }
}

function checkSkills(o: DoctorOptions, id: AgentId): Check {
  const cid = `skills:${id}`
  const shared = agentsSkillsDir(o.home)
  const bad: string[] = []
  for (const name of SKILL_NAMES) {
    const target = join(shared, name)
    if (!existsSync(join(target, "SKILL.md"))) {
      bad.push(`${tilde(o.home, target)}/SKILL.md missing`)
      continue
    }
    if (id === "claude-code") {
      const link = join(claudeSkillsDir(o.home), name)
      if (linkState(link, target) !== "ours") bad.push(`${tilde(o.home, link)} is not a symlink to ${tilde(o.home, target)}`)
    }
  }
  if (bad.length) return { id: cid, ok: false, detail: bad.join("; "), fix: initFix }
  return { id: cid, ok: true, detail: `${SKILL_NAMES.length} skills in ${tilde(o.home, shared)}` }
}

/** Read-only health checks. Never writes anything. */
export async function runDoctor(o: DoctorOptions): Promise<Check[]> {
  const kiteHome = o.env.KITE_HOME || join(o.home, ".kitestring")
  const plat = o.platform ?? process.platform
  const dir = hostsDir({ browser: "chrome", home: o.home, platform: plat, localAppData: localAppData(o.env, o.home) })
  const wrapper = join(kiteHome, hostWrapperName(plat))
  const checks: Check[] = []

  const v = o.nodeVersion ?? process.versions.node
  checks.push(
    nodeOk(v)
      ? { id: "node", ok: true, detail: `node ${v}` }
      : { id: "node", ok: false, detail: `node ${v} is older than ${MIN_NODE.join(".")}`, fix: "install Node 22.12 or newer, then re-run `kite init`" },
  )
  checks.push(checkManifest(o, dir, wrapper))
  checks.push(checkWrapper(o, wrapper))
  checks.push(checkCli(o, kiteHome))
  const { bridge, extension } = await checkBridge(plat === "win32" ? socketPath("win32") : join(kiteHome, "kite.sock"))
  checks.push(bridge, extension)
  for (const a of detect(o.home)) {
    if (!a.present) continue
    const entry = await mcpBin(o, a.id, a.configDir)
    if (entry.missing) {
      // Installed but never registered (e.g. kite init --agents for another agent): not a failure.
      const detail = `not registered (skipped) — run \`kite init\` to add`
      checks.push({ id: `mcp:${a.id}`, ok: true, detail }, { id: `skills:${a.id}`, ok: true, detail })
      continue
    }
    checks.push(checkMcp(a.id, entry))
    checks.push(checkSkills(o, a.id))
  }
  return checks
}

export function formatChecks(checks: Check[]): string {
  const lines: string[] = []
  for (const c of checks) {
    lines.push(`${c.ok ? "✓" : "✗"} ${c.id}: ${c.detail}`)
    if (!c.ok && c.fix) lines.push(`    fix: ${c.fix}`)
  }
  return lines.join("\n")
}
