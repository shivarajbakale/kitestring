import { chmodSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { HOST_NAME, LEGACY_HOST_NAMES, PRODUCT } from "@kitestring/protocol"
import { nodeCandidates } from "../init/node-path.js"

export interface InstallOpts {
  browser: "chrome" | "chromium"
  userDataDir?: string
  extensionId: string
  kiteHome: string
  /** Home dir to install under (defaults to the OS home); injectable so tests never touch the real one. */
  home?: string
}

export function hostsDir(o: Pick<InstallOpts, "browser" | "userDataDir" | "home">): string {
  if (o.userDataDir) return join(o.userDataDir, "NativeMessagingHosts")
  const h = o.home ?? homedir()
  if (platform() === "darwin") {
    return join(h, "Library", "Application Support", o.browser === "chrome" ? "Google/Chrome" : "Chromium", "NativeMessagingHosts")
  }
  return join(h, ".config", o.browser === "chrome" ? "google-chrome" : "chromium", "NativeMessagingHosts")
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function wrapperScript(kiteHome: string, candidates: string[], mainJs: string): string {
  return [
    "#!/bin/sh",
    `export KITE_HOME=${q(kiteHome)}`,
    `for n in ${candidates.map(q).join(" ")}; do`,
    `  [ -x "$n" ] && exec "$n" ${q(mainJs)}`,
    "done",
    'echo "kitestring: no node found" >&2',
    "exit 127",
    "",
  ].join("\n")
}

/**
 * What to tell the user after installHost: each legacy (bx) manifest it removed, and that the old
 * `~/.bx` home can be deleted. Never deletes `~/.bx` itself.
 */
export function legacyNotices(r: { removedLegacy: string[] }, home: string = homedir()): string[] {
  const lines = r.removedLegacy.map((p) => `removed legacy manifest ${p}`)
  if (existsSync(join(home, ".bx"))) lines.push("old bx home ~/.bx is no longer used — delete it when ready")
  return lines
}

export function installHost(o: InstallOpts): { manifestPath: string; wrapperPath: string; removedLegacy: string[] } {
  // Always point at the built host (dist/host/main.js), even when running from src (tests).
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
  const mainJs = join(pkgRoot, "dist", "host", "main.js")
  mkdirSync(o.kiteHome, { recursive: true, mode: 0o700 })
  const wrapperPath = join(o.kiteHome, "host.sh")
  writeFileSync(wrapperPath, wrapperScript(o.kiteHome, nodeCandidates(), mainJs))
  chmodSync(wrapperPath, 0o755)

  const dir = hostsDir(o)
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, `${HOST_NAME}.json`)
  const manifest = {
    name: HOST_NAME,
    description: `${PRODUCT} browser bridge`,
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${o.extensionId}/`],
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  const removedLegacy: string[] = []
  for (const legacy of LEGACY_HOST_NAMES) {
    const p = join(dir, `${legacy}.json`)
    if (existsSync(p)) {
      rmSync(p)
      removedLegacy.push(p)
    }
  }
  return { manifestPath, wrapperPath, removedLegacy }
}
