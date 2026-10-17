import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** The skills we ship (folders under the repo's `skills/` that contain SKILL.md). Nothing else is copied. */
export const SKILL_NAMES = ["kitestring", "kitestring-debug-frontend", "kitestring-e2e-verify"] as const

/** `<repo>/skills`, resolved from this file's location (works from both `src/init` and `dist/init`). */
export function repoSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "skills")
}

export const agentsSkillsDir = (home: string) => join(home, ".agents", "skills")
export const claudeSkillsDir = (home: string) => join(home, ".claude", "skills")

function tree(dir: string, prefix = ""): Map<string, string> {
  const m = new Map<string, string>()
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) m.set(prefix + e, "link:" + readlinkSync(p))
    else if (st.isDirectory()) for (const [k, v] of tree(p, prefix + e + "/")) m.set(k, v)
    else m.set(prefix + e, readFileSync(p, "utf8"))
  }
  return m
}

/** True when `dest` is a real directory with exactly the same files and contents as `src`. */
export function sameTree(src: string, dest: string): boolean {
  if (!existsSync(dest) || lstatSync(dest).isSymbolicLink() || !lstatSync(dest).isDirectory()) return false
  const a = tree(src)
  const b = tree(dest)
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

export type LinkState = "missing" | "ours" | "other-symlink" | "not-symlink"

/** State of `~/.claude/skills/<name>` relative to the expected target. */
export function linkState(link: string, target: string): LinkState {
  let st
  try {
    st = lstatSync(link)
  } catch {
    return "missing"
  }
  if (!st.isSymbolicLink()) return "not-symlink"
  return resolve(dirname(link), readlinkSync(link)) === target ? "ours" : "other-symlink"
}

/** A symlink that points somewhere inside `~/.agents/skills` (what uninstall may remove). */
export function pointsInto(link: string, dir: string): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false
  } catch {
    return false
  }
  return resolve(dirname(link), readlinkSync(link)).startsWith(dir + sep)
}
