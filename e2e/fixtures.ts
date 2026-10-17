import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test as base, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test"
import { EXTENSION_ID } from "@bx/protocol"
import { startTorture } from "../apps/torture/server.ts"

// Builds nothing: run `pnpm build` first.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = join(ROOT, "packages", "cli", "dist", "bin.js")
const EXTENSION = join(ROOT, "packages", "extension", "build", "chrome-mv3-prod")

export interface BxRun {
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

export interface Fixtures {
  bxHome: string
  torture: string
  context: BrowserContext
  /** The extension's background service worker (for inspecting chrome.* state). */
  sw: Worker
  bx: (...args: string[]) => Promise<BxRun>
  bxEnv: (env: Record<string, string>, ...args: string[]) => Promise<BxRun>
  /** Reads `window.__result` from the page whose tab is the given session's active tab. */
  result: (page: Page) => Promise<string>
}

function runBx(bxHome: string, env: Record<string, string>, args: string[]): Promise<BxRun> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, BX_SESSION: "", ...env, BX_HOME: bxHome },
    })
    let stdout = ""
    let stderr = ""
    p.stdout.on("data", (d) => (stdout += d))
    p.stderr.on("data", (d) => (stderr += d))
    p.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }))
  })
}

export const test = base.extend<Fixtures>({
  // Short prefix: unix socket paths are limited to ~104 bytes on macOS.
  bxHome: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "bxh-"))
    await use(dir)
    rmSync(dir, { recursive: true, force: true })
  },
  torture: async ({}, use) => {
    const t = await startTorture(0)
    await use(t.url)
    await t.close()
  },
  context: async ({ bxHome }, use) => {
    if (!existsSync(join(EXTENSION, "manifest.json")) || !existsSync(BIN)) {
      throw new Error("extension or CLI not built — run `pnpm build` first")
    }
    const userDataDir = mkdtempSync(join(tmpdir(), "bxu-"))
    // Native host discovery: Chromium reads <userDataDir>/NativeMessagingHosts when launched
    // with a custom --user-data-dir, so nothing is written outside the temp dirs.
    const inst = await runBx(bxHome, {}, [
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
      env: { ...process.env, BX_HOME: bxHome },
    })
    try {
      const deadline = Date.now() + 10_000
      for (;;) {
        const r = await runBx(bxHome, {}, ["status"])
        if (r.code === 0) break
        if (Date.now() > deadline) throw new Error(`bx status never connected: ${r.stdout}${r.stderr}`)
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
    if (!w) throw new Error("bx extension service worker not found")
    await use(w)
  },
  // Depending on `context` guarantees the browser is up and connected before any bx call.
  bx: async ({ bxHome, context }, use) => {
    void context
    await use((...args) => runBx(bxHome, {}, args))
  },
  bxEnv: async ({ bxHome, context }, use) => {
    void context
    await use((env, ...args) => runBx(bxHome, env, args))
  },
  result: async ({}, use) => {
    await use(async (page) => String(await page.evaluate(() => (window as unknown as { __result?: unknown }).__result)))
  },
})

export { expect } from "@playwright/test"
