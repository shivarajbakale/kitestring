import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { AGENTS, type AgentId } from "./agents.js"

export interface DetectedAgent {
  id: AgentId
  /** The agent's config dir, e.g. `~/.codex`. */
  configDir: string
  /** How to show the dir to the user, e.g. `~/.codex`. */
  display: string
  present: boolean
}

const DIRS: Record<AgentId, string[]> = {
  "claude-code": [".claude"],
  codex: [".codex"],
  cursor: [".cursor"],
  gemini: [".gemini"],
  opencode: [".config", "opencode"],
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory()

/** All five agents in fixed order; an agent is present iff its config dir exists under `home`. */
export function detect(home: string): DetectedAgent[] {
  return AGENTS.map((id) => {
    const configDir = join(home, ...DIRS[id])
    return { id, configDir, display: "~/" + DIRS[id].join("/"), present: isDir(configDir) }
  })
}
