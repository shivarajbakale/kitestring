import { realpathSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { KiteError } from "./client/rpc-client.js"

export const MAX_UPLOAD_BYTES = 104_857_600

export interface UploadGuardOpts {
  cwd: string
  home: string
  kiteHome: string
  env: NodeJS.ProcessEnv
}

/** Directories (relative to home) whose files are never uploaded, unless `KITE_UPLOAD_ALLOW` names them. */
const DENIED_UNDER_HOME = [".ssh", ".aws", ".gnupg", ".kitestring", ".config", join("Library", "Keychains")]

const refuse = (path: string, reason: string): never => {
  throw new KiteError("BAD_REQUEST", `refusing to upload ${path}: ${reason}`)
}

function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p
}

/** realpath, or the plain resolved path for something that does not exist (a denied dir that is absent). */
function real(p: string): string {
  try {
    // native: the on-disk spelling, so `.SSH` on a case-insensitive volume becomes `.ssh`
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/** Case-folded compare: macOS and Windows volumes are case-insensitive, so spelling must not matter. */
function isUnder(file: string, dir: string): boolean {
  const rel = relative(dir.toLowerCase(), file.toLowerCase())
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))
}

/**
 * Resolves the paths against `cwd`, follows symlinks, and refuses anything that is not a regular file
 * of at most 100 MB, lives in a sensitive location, or is a `.env*` file. The deny check runs on the
 * real path, so a symlink into `~/.ssh` is refused. `KITE_UPLOAD_ALLOW` (colon-separated dirs)
 * overrides the location rules only; size, type and `.env*` still apply.
 */
export function resolveUploads(paths: string[], opts: UploadGuardOpts): string[] {
  const home = real(opts.home)
  const denied = [...DENIED_UNDER_HOME.map((d) => join(home, d)), real(opts.kiteHome)].map(real)
  const allowed = (opts.env.KITE_UPLOAD_ALLOW ?? "")
    .split(":")
    .filter(Boolean)
    .map((d) => real(resolve(opts.cwd, expandHome(d, opts.home))))

  return paths.map((given) => {
    const full = resolve(opts.cwd, expandHome(given, opts.home))
    let file: string
    try {
      file = realpathSync.native(full)
    } catch {
      return refuse(given, "not found")
    }
    let st
    try {
      st = statSync(file)
    } catch {
      return refuse(given, "not found")
    }
    if (!st.isFile()) refuse(given, "not a regular file")
    if (st.size > MAX_UPLOAD_BYTES) refuse(given, "larger than 100 MB")
    if (/^\.env/i.test(basename(file)) || /^\.env/i.test(basename(full))) refuse(given, "sensitive location")
    if (denied.some((d) => isUnder(file, d)) && !allowed.some((a) => isUnder(file, a))) refuse(given, "sensitive location")
    return file
  })
}
