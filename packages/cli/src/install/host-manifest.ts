import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { HOST_NAME } from "@bx/protocol"

export interface InstallOpts {
  browser: "chrome" | "chromium"
  userDataDir?: string
  extensionId: string
  bxHome: string
}

function hostsDir(o: InstallOpts): string {
  if (o.userDataDir) return join(o.userDataDir, "NativeMessagingHosts")
  const h = homedir()
  if (platform() === "darwin") {
    return join(h, "Library", "Application Support", o.browser === "chrome" ? "Google/Chrome" : "Chromium", "NativeMessagingHosts")
  }
  return join(h, ".config", o.browser === "chrome" ? "google-chrome" : "chromium", "NativeMessagingHosts")
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function installHost(o: InstallOpts): { manifestPath: string; wrapperPath: string } {
  // Always point at the built host (dist/host/main.js), even when running from src (tests).
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
  const mainJs = join(pkgRoot, "dist", "host", "main.js")
  mkdirSync(o.bxHome, { recursive: true, mode: 0o700 })
  const wrapperPath = join(o.bxHome, "host.sh")
  writeFileSync(wrapperPath, `#!/bin/sh\nexport BX_HOME=${q(o.bxHome)}\nexec ${q(process.execPath)} ${q(mainJs)}\n`)
  chmodSync(wrapperPath, 0o755)

  const dir = hostsDir(o)
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, `${HOST_NAME}.json`)
  const manifest = {
    name: HOST_NAME,
    description: "bx browser bridge",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${o.extensionId}/`],
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  return { manifestPath, wrapperPath }
}
