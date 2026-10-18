import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test as base, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test"
import { EXTENSION_ID } from "@kitestring/protocol"
import { startTorture } from "../apps/torture/server.ts"

// Builds nothing: run `pnpm build` first.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = join(ROOT, "packages", "cli", "dist", "bin.js")
const EXTENSION = join(ROOT, "packages", "extension", "build", "chrome-mv3-prod")

export interface KiteRun {
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

export interface Fixtures {
  kiteHome: string
  torture: string
  context: BrowserContext
  /** The extension's background service worker (for inspecting chrome.* state). */
  sw: Worker
  kite: (...args: string[]) => Promise<KiteRun>
  kiteEnv: (env: Record<string, string>, ...args: string[]) => Promise<KiteRun>
  /** Runs kite with `input` written to its stdin (e.g. `kite batch -`). */
  kiteStdin: (input: string, ...args: string[]) => Promise<KiteRun>
  /** Reads `window.__result` from the page whose tab is the given session's active tab. */
  result: (page: Page) => Promise<string>
}

function runKite(kiteHome: string, env: Record<string, string>, args: string[], input?: string): Promise<KiteRun> {
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

export const test = base.extend<Fixtures>({
  // Short prefix: unix socket paths are limited to ~104 bytes on macOS.
  kiteHome: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "kiteh-"))
    await use(dir)
    rmSync(dir, { recursive: true, force: true })
  },
  torture: async ({}, use) => {
    const t = await startTorture(0)
    await use(t.url)
    await t.close()
  },
  context: async ({ kiteHome }, use) => {
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
      env: { ...process.env, KITE_HOME: kiteHome },
    })
    try {
      const deadline = Date.now() + 10_000
      for (;;) {
        const r = await runKite(kiteHome, {}, ["status"])
        if (r.code === 0) break
        if (Date.now() > deadline) throw new Error(`kite status never connected: ${r.stdout}${r.stderr}`)
        await new Promise((res) => setTimeout(res, 250))
      }
      await use(context)
    } finally {
      await context.close()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  },
  sw: async ({ context }, use) => {
    const w = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`))
    if (!w) throw new Error("kite extension service worker not found")
    await use(w)
  },
  // Depending on `context` guarantees the browser is up and connected before any kite call.
  kite: async ({ kiteHome, context }, use) => {
    void context
    await use((...args) => runKite(kiteHome, {}, args))
  },
  kiteEnv: async ({ kiteHome, context }, use) => {
    void context
    await use((env, ...args) => runKite(kiteHome, env, args))
  },
  kiteStdin: async ({ kiteHome, context }, use) => {
    void context
    await use((input, ...args) => runKite(kiteHome, {}, args, input))
  },
  result: async ({}, use) => {
    await use(async (page) => String(await page.evaluate(() => (window as unknown as { __result?: unknown }).__result)))
  },
})

export { expect } from "@playwright/test"
