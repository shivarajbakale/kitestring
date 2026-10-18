import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { EXTENSION_ID } from "@kitestring/protocol"
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures"

// Chrome Web Store screenshots (1280x800). Only written with KITE_UPDATE_DOCS=1: they share the port and
// the browser with the other e2e specs, so a normal run skips them.
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "store", "screenshots")
const UPDATE = process.env.KITE_UPDATE_DOCS === "1"

async function shoot(page: Page, file: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, file) })
}

test.describe("store screenshots", () => {
  test.skip(!UPDATE, "set KITE_UPDATE_DOCS=1 to refresh store/screenshots")

  test("popup, live view, and a batch filling the store listing", async ({ kite, kiteStdin, context, torture }) => {
    const url = `${torture}/store-listing`
    expect((await kite("tab", "new", url)).code).toBe(0)
    const site = context.pages().find((p) => p.url() === url)!
    await site.setViewportSize({ width: 1280, height: 800 })

    const popup = await context.newPage()
    await popup.setViewportSize({ width: 1280, height: 800 })
    await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`)
    await expect(popup.getByText("Connected", { exact: true })).toBeVisible()
    await shoot(popup, "1-popup.png")

    const steps = [
      { action: "fill", target: "Title", value: "Kitestring" },
      { action: "fill", target: "Summary", value: "Let your AI agent drive your real Chrome, with its memory and a cache that make repeat tasks fast." },
      { action: "fill", target: "Description", value: "Agents plan; Kitestring acts, remembers and replays." },
      { action: "select", target: "Category", value: "Developer Tools" },
      { action: "select", target: "Language", value: "English" },
    ]
    const r = await kiteStdin(JSON.stringify(steps), "batch", "-")
    expect(r.code, r.stdout + r.stderr).toBe(0)
    await site.bringToFront()
    await shoot(site, "2-batch-filled.png")

    const panel = await context.newPage()
    await panel.setViewportSize({ width: 1280, height: 800 })
    await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`)
    await expect(panel.getByText(/batch|fill/i).first()).toBeVisible()
    await shoot(panel, "3-live-view.png")
  })
})
