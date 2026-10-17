import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { delimiter, join, resolve } from "node:path"

/** First line after the shebang: marks the file as ours (uninstall removes only this). */
export const SHIM_MARKER = "# kitestring cli shim (written by kite init)"

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** `$KITE_HOME/bin`: the directory to put on PATH. */
export const shimDir = (kiteHome: string): string => join(kiteHome, "bin")
export const shimPath = (kiteHome: string): string => join(shimDir(kiteHome), "kite")

/**
 * `kite` for agents and shells without an alias: tries the same node candidates as the host wrapper,
 * then runs bin.js with all arguments. KITE_HOME defaults to the one init used.
 */
export function shimScript(kiteHome: string, candidates: string[], binJs: string): string {
  return [
    "#!/bin/sh",
    SHIM_MARKER,
    `[ -n "\${KITE_HOME:-}" ] || KITE_HOME=${q(kiteHome)}`,
    "export KITE_HOME",
    `for n in ${candidates.map(q).join(" ")}; do`,
    `  [ -x "$n" ] && exec "$n" ${q(binJs)} "$@"`,
    "done",
    'echo "kite: no node found" >&2',
    "exit 127",
    "",
  ].join("\n")
}

export const isOurShim = (p: string): boolean => {
  try {
    return readFileSync(p, "utf8").split("\n")[1] === SHIM_MARKER
  } catch {
    return false
  }
}

export const isExecutableFile = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Is `dir` one of PATH's entries? */
export function onPath(dir: string, path: string | undefined): boolean {
  const want = resolve(dir)
  return (path ?? "").split(delimiter).some((d) => d && resolve(d) === want)
}

/** The line to add to a shell profile, e.g. `export PATH="$HOME/.kitestring/bin:$PATH"`. */
export function pathLine(home: string, kiteHome: string): string {
  const dir = shimDir(kiteHome)
  const shown = dir.startsWith(home + "/") ? "$HOME" + dir.slice(home.length).replace(/["\\$`]/g, "\\$&") : dir.replace(/["\\$`]/g, "\\$&")
  return `export PATH="${shown}:$PATH"`
}
