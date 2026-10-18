import { win32 } from "node:path"

export const AGENTS = ["claude-code", "codex", "cursor", "gemini", "opencode"] as const
export type AgentId = (typeof AGENTS)[number]

export const SERVER_NAME = "kitestring"

export function parseAgents(list: string): AgentId[] {
  const ids = list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) throw new Error(`--agents needs at least one of ${AGENTS.join(", ")}`)
  for (const id of ids) {
    if (!(AGENTS as readonly string[]).includes(id)) throw new Error(`unknown agent "${id}" (known: ${AGENTS.join(", ")})`)
  }
  return AGENTS.filter((a) => ids.includes(a))
}

export interface Launch {
  node: string
  bin: string
}

/** `~/.claude.json` top-level `mcpServers.kitestring` (used when the `claude` CLI is not on PATH). */
export const claudeEntry = ({ node, bin }: Launch) => ({
  type: "stdio",
  command: node,
  args: [bin, "mcp"],
  env: { KITE_SESSION: "claude-code" },
})

/** argv (after `claude`) that registers the server at user scope. `-e` is variadic, so it goes after the name. */
export const claudeAddArgv = ({ node, bin }: Launch) => [
  "mcp", "add", "--transport", "stdio", "--scope", "user", SERVER_NAME, "-e", "KITE_SESSION=claude-code", "--", node, bin, "mcp",
]
export const claudeRemoveArgv = () => ["mcp", "remove", SERVER_NAME, "--scope", "user"]
export const claudeGetArgv = () => ["mcp", "get", SERVER_NAME]

export const cursorEntry = ({ node, bin }: Launch) => ({
  type: "stdio",
  command: node,
  args: [bin, "mcp"],
  env: { KITE_SESSION: "cursor" },
})

export const geminiEntry = ({ node, bin }: Launch) => ({
  command: node,
  args: [bin, "mcp"],
  env: { KITE_SESSION: "gemini" },
  timeout: 60000,
})

export const opencodeEntry = ({ node, bin }: Launch) => ({
  type: "local",
  command: [node, bin, "mcp"],
  enabled: true,
  // OpenCode gives tool calls ~15 s: keep a batch well inside it (the default budget is 40 s).
  environment: { KITE_SESSION: "opencode", KITE_BATCH_BUDGET_MS: "12000" },
  timeout: 15000,
})

export const CODEX_TABLE = `mcp_servers.${SERVER_NAME}`

export function codexBlock({ node, bin }: Launch): string {
  const s = (v: string) => JSON.stringify(v)
  return [
    `[${CODEX_TABLE}]`,
    `command = ${s(node)}`,
    `args = [${s(bin)}, "mcp"]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60",
    "",
    `[${CODEX_TABLE}.env]`,
    `KITE_SESSION = "codex"`,
  ].join("\n")
}

/** Config files of the file-based agents on Windows, under `%USERPROFILE%` (Claude uses `claude mcp add`). */
export function windowsAgentConfigFiles(userProfile: string): Record<"codex" | "cursor" | "gemini" | "opencode", string> {
  const j = (...p: string[]) => win32.join(userProfile, ...p)
  return {
    codex: j(".codex", "config.toml"),
    cursor: j(".cursor", "mcp.json"),
    gemini: j(".gemini", "settings.json"),
    opencode: j(".config", "opencode", "opencode.json"),
  }
}
