import { existsSync } from "node:fs"

export interface NodePathOpts {
  execPath?: string
  exists?: (p: string) => boolean
}

const STABLE = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]

/**
 * Node binaries to try, in order: process.execPath unless it lives in a versioned Homebrew
 * Cellar (which disappears on upgrade), then the stable Homebrew/system paths, then execPath
 * as a last resort. Missing files are dropped, except the final execPath fallback.
 */
export function nodeCandidates(o: NodePathOpts = {}): string[] {
  const execPath = o.execPath ?? process.execPath
  const exists = o.exists ?? existsSync
  const list: string[] = []
  if (!execPath.includes("/Cellar/") && exists(execPath)) list.push(execPath)
  for (const p of STABLE) if (exists(p)) list.push(p)
  list.push(execPath)
  return [...new Set(list)]
}

export function resolveNode(o: NodePathOpts = {}): string {
  return nodeCandidates(o)[0]!
}
