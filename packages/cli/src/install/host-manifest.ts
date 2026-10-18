import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { HOST_NAME, KITE_STORE_EXTENSION_ID, LEGACY_HOST_NAMES, PRODUCT } from "@kitestring/protocol"
import { localAppData as defaultLocalAppData } from "../paths.js"
import { nodeCandidates } from "../init/node-path.js"

export interface InstallOpts {
  browser: "chrome" | "chromium"
  userDataDir?: string
  extensionId: string
  /** Web Store extension id to allow as well (defaults to KITE_STORE_EXTENSION_ID; empty means none). */
  storeExtensionId?: string
  kiteHome: string
  /** Home dir to install under (defaults to the OS home); injectable so tests never touch the real one. */
  home?: string
  /** Defaults to the running platform; injectable so the win32 path is testable anywhere. */
  platform?: NodeJS.Platform
  /** win32: `%LOCALAPPDATA%` (defaults to the env var). */
  localAppData?: string
  /** win32: runs `reg`; injectable so tests never touch a registry. */
  execFile?: (file: string, args: string[]) => void
}

/** Origins the native host accepts: the dev extension id, plus the Web Store id when one is set. */
export function allowedOrigins(extensionId: string, storeExtensionId: string = KITE_STORE_EXTENSION_ID): string[] {
  const ids = [extensionId, storeExtensionId].filter((id, i, all) => id !== "" && all.indexOf(id) === i)
  return ids.map((id) => `chrome-extension://${id}/`)
}

/** win32 registry key that points a browser at the host manifest. */
export const regKey = (browser: InstallOpts["browser"]): string =>
  `HKCU\\Software\\${browser === "chrome" ? "Google\\Chrome" : "Chromium"}\\NativeMessagingHosts\\${HOST_NAME}`

function hostCmd(kiteHome: string, node: string, mainJs: string): string {
  return ["@echo off", `set "KITE_HOME=${kiteHome}"`, `"${node}" "${mainJs}" %*`, ""].join("\r\n")
}

export function hostsDir(o: Pick<InstallOpts, "browser" | "userDataDir" | "home" | "platform" | "localAppData">): string {
  if ((o.platform ?? process.platform) === "win32") return join(o.localAppData ?? defaultLocalAppData(), "Kitestring")
  if (o.userDataDir) return join(o.userDataDir, "NativeMessagingHosts")
  const h = o.home ?? homedir()
  if (platform() === "darwin") {
    return join(h, "Library", "Application Support", o.browser === "chrome" ? "Google/Chrome" : "Chromium", "NativeMessagingHosts")
  }
  return join(h, ".config", o.browser === "chrome" ? "google-chrome" : "chromium", "NativeMessagingHosts")
}

/** `host.sh` on POSIX, `host.cmd` on Windows. */
export const hostWrapperName = (plat: NodeJS.Platform = process.platform): string => (plat === "win32" ? "host.cmd" : "host.sh")

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
  const win = (o.platform ?? process.platform) === "win32"
  const wrapperPath = join(o.kiteHome, hostWrapperName(win ? "win32" : "linux"))
  if (win) {
    writeFileSync(wrapperPath, hostCmd(o.kiteHome, nodeCandidates()[0]!, mainJs))
  } else {
    writeFileSync(wrapperPath, wrapperScript(o.kiteHome, nodeCandidates(), mainJs))
    chmodSync(wrapperPath, 0o755)
  }

  const dir = hostsDir({ ...o, platform: win ? "win32" : undefined })
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, `${HOST_NAME}.json`)
  const manifest = {
    name: HOST_NAME,
    description: `${PRODUCT} browser bridge`,
    path: wrapperPath,
    type: "stdio",
    allowed_origins: allowedOrigins(o.extensionId, o.storeExtensionId),
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  if (win) (o.execFile ?? ((f, a) => void execFileSync(f, a, { stdio: "ignore" })))("reg", ["add", regKey(o.browser), "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"])
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
