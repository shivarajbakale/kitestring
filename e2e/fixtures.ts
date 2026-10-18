import { rmSync } from "node:fs"
import { test as base, type BrowserContext, type Page, type Worker } from "@playwright/test"
import { EXTENSION_ID } from "@kitestring/protocol"
import { startTorture } from "../apps/torture/server.ts"
import { launchWithExtension, makeKiteHome, runKite, type KiteRun } from "./launch.ts"

export type { KiteRun }

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

export const test = base.extend<Fixtures>({
  kiteHome: async ({}, use) => {
    const dir = makeKiteHome()
    await use(dir)
    rmSync(dir, { recursive: true, force: true })
  },
  torture: async ({}, use) => {
    const t = await startTorture(0)
    await use(t.url)
    await t.close()
  },
  context: async ({ kiteHome }, use) => {
    const { context, close } = await launchWithExtension(kiteHome)
    try {
      await use(context)
    } finally {
      await close()
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
