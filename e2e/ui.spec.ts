import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { EXTENSION_ID } from "@kitestring/protocol"
import type { BrowserContext, Page } from "@playwright/test"
import { expect, test } from "./fixtures"

const POPUP = `chrome-extension://${EXTENSION_ID}/popup.html`
const DOCS_UI = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "ui")
const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr

async function openPopup(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.setViewportSize({ width: 360, height: 600 })
  await page.goto(POPUP)
  return page
}

test.describe("toolbar popup", () => {
  test("shows the connection, lists the session, and pauses and resumes agents", async ({ kite, context, torture }) => {
    const popup = await openPopup(context)
    await expect(popup.getByText("Connected", { exact: true })).toBeVisible()
    await expect(popup.getByText(/kite init/)).toBeVisible() // empty state

    const t = await kite("tab", "new", `${torture}/serial`)
    expect(t.code, out(t)).toBe(0)

    const row = popup.getByRole("button", { name: /default/ })
    await expect(row).toBeVisible()
    await expect(row).toContainText("1 tab")
    await expect(row).toContainText(/tab\.new/) // last action

    await popup.getByRole("button", { name: "Pause agents" }).click()
    await expect(popup.getByRole("button", { name: "Resume" })).toBeVisible()
    const paused = await kite("click", "Fast task")
    expect(paused.code).toBe(1)
    expect(out(paused)).toContain("PAUSED")

    // The optional reason reaches the agents.
    await popup.getByLabel("Reason (optional)").fill("checking the checkout")
    await popup.getByLabel("Reason (optional)").press("Enter")
    await expect.poll(async () => out(await kite("click", "Fast task"))).toContain("checking the checkout")

    await popup.getByRole("button", { name: "Resume" }).click()
    await expect(popup.getByRole("button", { name: "Pause agents" })).toBeVisible()
    const resumed = await kite("click", "Fast task")
    expect(out(resumed)).toMatch(/^✓ done$/m)
    expect(resumed.code).toBe(0)

    // Clicking the row brings the session's tab to the front.
    await popup.bringToFront()
    await row.click()
    const sessionPage = context.pages().find((p) => p.url() === `${torture}/serial`)!
    await expect.poll(() => sessionPage.evaluate(() => document.visibilityState)).toBe("visible")
  })

  test("Open live view opens the side panel from the click", async ({ context }) => {
    const popup = await openPopup(context)
    const link = popup.getByRole("button", { name: "Open live view" })
    await expect(link).toBeEnabled() // windowId known
    const closed = popup.waitForEvent("close") // the popup closes itself once the panel is open
    await link.click()
    await closed
    // Playwright doesn't list side-panel pages; the CDP target list does.
    const cdp = await context.newCDPSession(await context.newPage())
    const panelOpen = async () =>
      (await cdp.send("Target.getTargets")).targetInfos.some((t) => t.url === `chrome-extension://${EXTENSION_ID}/sidepanel.html`)
    await expect.poll(panelOpen, { timeout: 5000 }).toBe(true)
  })

  test("pause state set by the CLI shows in the popup", async ({ kite, context }) => {
    const popup = await openPopup(context)
    await expect(popup.getByRole("button", { name: "Pause agents" })).toBeVisible()
    expect((await kite("pause", "lunch")).code).toBe(0)
    await expect(popup.getByRole("button", { name: "Resume" })).toBeVisible()
    await expect(popup.getByLabel("Reason (optional)")).toHaveValue("lunch")
    expect((await kite("resume")).code).toBe(0)
    await expect(popup.getByRole("button", { name: "Pause agents" })).toBeVisible()
  })

  test("screenshots in light and dark", async ({ kite, kiteEnv, context, torture }) => {
    expect((await kite("tab", "new", `${torture}/serial`)).code).toBe(0)
    expect((await kite("click", "Fast task")).code).toBe(0)
    expect((await kiteEnv({ KITE_SESSION: "claude-code" }, "tab", "new", `${torture}/basic-form`)).code).toBe(0)
    expect((await kiteEnv({ KITE_SESSION: "claude-code" }, "tab", "new", `${torture}/serial`)).code).toBe(0)
    mkdirSync(DOCS_UI, { recursive: true })
    const shoot = async (name: string) => {
      for (const scheme of ["light", "dark"] as const) {
        const popup = await openPopup(context)
        await popup.emulateMedia({ colorScheme: scheme })
        await expect(popup.getByRole("button", { name: /claude-code/ })).toBeVisible()
        await popup.evaluate(() => document.fonts.ready)
        // 2x for the docs: the persistent context's pages are 1x, so zoom the page instead.
        await popup.setViewportSize({ width: 720, height: 1400 })
        await popup.evaluate(() => (document.documentElement.style.zoom = "2"))
        await popup.locator("main").screenshot({ path: join(DOCS_UI, `${name}-${scheme}.png`) })
        await popup.close()
      }
    }
    await shoot("popup")
    expect((await kite("pause", "reviewing the cart")).code).toBe(0)
    await shoot("popup-paused")
  })
})
