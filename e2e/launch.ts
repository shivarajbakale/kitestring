import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type BrowserContext } from "@playwright/test"
import { EXTENSION_ID } from "@kitestring/protocol"

// Builds nothing: run `pnpm build` first.
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const BIN = join(ROOT, "packages", "cli", "dist", "bin.js")
export const EXTENSION = join(ROOT, "packages", "extension", "build", "chrome-mv3-prod")

export interface KiteRun {
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

/** Short prefix: unix socket paths are limited to ~104 bytes on macOS. */
export function makeKiteHome(): string {
  return mkdtempSync(join(tmpdir(), "kiteh-"))
}

export function runKite(kiteHome: string, env: Record<string, string>, args: string[], input?: string): Promise<KiteRun> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, KITE_SESSION: "", ...env, KITE_HOME: kiteHome },
    })
    if (input !== undefined) p.stdin.end(input)
    let stdout = ""
    let stderr = ""
    p.stdout.on("data", (d) => (stdout += d))
    p.stderr.on("data", (d) => (stderr += d))
    p.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }))
  })
}

/**
 * Installs the native host into a throwaway profile, launches Chromium with the extension, and waits until
 * `kite status` connects. `close()` shuts the browser down and removes the profile.
 */
export async function launchWithExtension(kiteHome: string): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  if (!existsSync(join(EXTENSION, "manifest.json")) || !existsSync(BIN)) {
    throw new Error("extension or CLI not built — run `pnpm build` first")
  }
  const userDataDir = mkdtempSync(join(tmpdir(), "kiteu-"))
  // Native host discovery: Chromium reads <userDataDir>/NativeMessagingHosts when launched
  // with a custom --user-data-dir, so nothing is written outside the temp dirs.
  const inst = await runKite(kiteHome, {}, [
    "install-host",
    "--browser",
    "chromium",
    "--user-data-dir",
    userDataDir,
    "--extension-id",
    EXTENSION_ID,
  ])
  if (inst.code !== 0) throw new Error(`install-host failed: ${inst.stderr}`)

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    env: { ...process.env, KITE_HOME: kiteHome } as Record<string, string>,
  })
  const close = async () => {
    await context.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
  try {
    const deadline = Date.now() + 10_000
    for (;;) {
      const r = await runKite(kiteHome, {}, ["status"])
      if (r.code === 0) break
      if (Date.now() > deadline) throw new Error(`kite status never connected: ${r.stdout}${r.stderr}`)
      await new Promise((res) => setTimeout(res, 250))
    }
  } catch (e) {
    await close()
    throw e
  }
  return { context, close }
}
