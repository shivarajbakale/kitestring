import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { delimiter, join, resolve } from "node:path"
import { localAppData as defaultLocalAppData } from "../paths.js"

/** First line after the shebang: marks the file as ours (uninstall removes only this). */
export const SHIM_MARKER = "# kitestring cli shim (written by kite init)"

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** `$KITE_HOME/bin`: the directory to put on PATH. */
export const SHIM_CMD_MARKER = "REM kitestring cli shim (written by kite init)"

export const shimDir = (kiteHome: string, plat: NodeJS.Platform = process.platform, localAppData: string = defaultLocalAppData()): string =>
  plat === "win32" ? join(localAppData, "Kitestring", "bin") : join(kiteHome, "bin")
export const shimPath = (kiteHome: string, plat: NodeJS.Platform = process.platform, localAppData?: string): string =>
  join(shimDir(kiteHome, plat, localAppData), plat === "win32" ? "kite.cmd" : "kite")

/** Windows `kite.cmd`: same job as shimScript, for cmd.exe. */
export function shimCmdScript(kiteHome: string, node: string, binJs: string): string {
  return [
    "@echo off",
    SHIM_CMD_MARKER,
    `if "%KITE_HOME%"=="" set "KITE_HOME=${kiteHome}"`,
    `"${node}" "${binJs}" %*`,
    "",
  ].join("\r\n")
}

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
    const line = readFileSync(p, "utf8").split("\n")[1]?.replace(/\r$/, "")
    return line === SHIM_MARKER || line === SHIM_CMD_MARKER
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
export function pathLine(home: string, kiteHome: string, plat: NodeJS.Platform = process.platform, localAppData?: string): string {
  const dir = shimDir(kiteHome, plat, localAppData)
  if (plat === "win32") return `add ${dir} to your user PATH (Settings > System > About > Advanced system settings > Environment Variables)`
  const shown = dir.startsWith(home + "/") ? "$HOME" + dir.slice(home.length).replace(/["\\$`]/g, "\\$&") : dir.replace(/["\\$`]/g, "\\$&")
  return `export PATH="${shown}:$PATH"`
}
