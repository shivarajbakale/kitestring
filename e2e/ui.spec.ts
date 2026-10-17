import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { EXTENSION_ID } from "@kitestring/protocol"
import type { BrowserContext, Page } from "@playwright/test"
import { expect, test } from "./fixtures"

const POPUP = `chrome-extension://${EXTENSION_ID}/popup.html`
const DOCS_UI = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "ui")
/** Screenshots refresh the committed docs/ui images only with KITE_UPDATE_DOCS=1; otherwise they go to the test's output dir. */
const shotPath = (file: string): string => {
  if (process.env.KITE_UPDATE_DOCS === "1") {
    return join(DOCS_UI, file)
  }
  return test.info().outputPath(file)
}
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
    const shoot = async (name: string) => {
      for (const scheme of ["light", "dark"] as const) {
        const popup = await openPopup(context)
        await popup.emulateMedia({ colorScheme: scheme })
        await expect(popup.getByRole("button", { name: /claude-code/ })).toBeVisible()
        await popup.evaluate(() => document.fonts.ready)
        // 2x for the docs: the persistent context's pages are 1x, so zoom the page instead.
        await popup.setViewportSize({ width: 720, height: 1400 })
        await popup.evaluate(() => (document.documentElement.style.zoom = "2"))
        await popup.locator("main").screenshot({ path: shotPath(`${name}-${scheme}.png`) })
        await popup.close()
      }
    }
    await shoot("popup")
    expect((await kite("pause", "reviewing the cart")).code).toBe(0)
    await shoot("popup-paused")
  })
})

const PANEL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`

async function openPanel(context: BrowserContext, width = 360): Promise<Page> {
  const page = await context.newPage()
  await page.setViewportSize({ width, height: 800 })
  await page.goto(PANEL)
  return page
}

test.describe("live side panel", () => {
  test("shows the activity newest first with badges, filters by session, and focuses the entry's tab", async ({
    kite,
    kiteEnv,
    context,
    torture,
  }) => {
    const panel = await openPanel(context)
    const feed = panel.getByRole("list", { name: "Activity" })
    await expect(panel.getByText(/No activity yet/)).toBeVisible()

    expect((await kite("tab", "new", `${torture}/basic-form`)).code).toBe(0)
    expect((await kite("fill", "Name", "Ada")).code).toBe(0)
    const missing = await kite("click", "Missing")
    expect(missing.code, out(missing)).toBe(1)

    const rows = feed.locator(":scope > li") // entries, not the diff lines inside them
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('click "Missing"')
    await expect(rows.nth(0).locator(".ks-badge")).toHaveText("not_found")
    await expect(rows.nth(1)).toContainText('fill "Name"')
    await expect(rows.nth(1).locator(".ks-badge")).toHaveText("done")
    await expect(rows.nth(2)).toContainText("tab.new")
    await expect(rows.nth(2).locator(".ks-badge")).toHaveText("done")
    await expect(feed).not.toContainText("Ada") // a fill value is never the logged target

    // Details: the diff and the page brief, as plain text.
    await rows.nth(1).getByRole("button", { name: /details/i }).click()
    await expect(rows.nth(1).getByRole("region", { name: /page brief/i })).toContainText("Basic form")

    // Another session's work shows up live; the filter hides it.
    expect((await kiteEnv({ KITE_SESSION: "codex" }, "tab", "new", `${torture}/serial`)).code).toBe(0)
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText("codex")
    const chips = panel.getByRole("group", { name: "Filter by session" })
    await chips.getByRole("button", { name: /default/ }).click()
    await expect(rows).toHaveCount(3)
    await expect(feed).not.toContainText("codex")
    await chips.getByRole("button", { name: /codex/ }).click()
    await expect(rows).toHaveCount(1)
    await chips.getByRole("button", { name: /All/ }).click()
    await expect(rows).toHaveCount(4)

    // Pause is mirrored at the top.
    await panel.getByRole("button", { name: "Pause agents" }).click()
    const paused = await kite("click", "Missing")
    expect(out(paused)).toContain("PAUSED")
    await expect(rows.nth(0).locator(".ks-badge")).toHaveText("PAUSED")
    await panel.getByRole("button", { name: "Resume" }).click()
    await expect(panel.getByRole("button", { name: "Pause agents" })).toBeVisible()

    // kite pause / resume (RPC) are recorded: verb plus the reason, status done.
    expect((await kite("pause", "lunch")).code).toBe(0)
    await expect(rows.nth(0).locator(".ks-entry__action")).toHaveText("pause")
    await expect(rows.nth(0)).toContainText("lunch")
    await expect(rows.nth(0).locator(".ks-badge")).toHaveText("done")
    expect((await kite("resume")).code).toBe(0)
    await expect(rows.nth(0).locator(".ks-entry__action")).toHaveText("resume")
    await expect(rows.nth(0).locator(".ks-badge")).toHaveText("done")

    // Clicking an entry brings its tab to the front.
    await panel.bringToFront()
    await feed.getByRole("button", { name: /fill "Name"/ }).click()
    const formPage = context.pages().find((p) => p.url() === `${torture}/basic-form`)!
    await expect.poll(() => formPage.evaluate(() => document.visibilityState)).toBe("visible")
  })

  test("screenshots in light and dark", async ({ kite, kiteEnv, context, torture }) => {
    expect((await kite("tab", "new", `${torture}/basic-form`)).code).toBe(0)
    expect((await kite("fill", "Name", "Ada")).code).toBe(0)
    expect((await kite("click", "Missing")).code).toBe(1)
    const cc = (...a: string[]) => kiteEnv({ KITE_SESSION: "claude-code" }, ...a)
    expect((await cc("tab", "new", `${torture}/serial`)).code).toBe(0)
    expect((await cc("click", "Fast task")).code).toBe(0)
    for (const width of [320, 600]) {
      for (const scheme of ["light", "dark"] as const) {
        const panel = await openPanel(context, width)
        await panel.emulateMedia({ colorScheme: scheme })
        const rows = panel.getByRole("list", { name: "Activity" }).locator(":scope > li")
        await expect(rows).toHaveCount(5)
        await rows.nth(3).getByRole("button", { name: /details/i }).click() // fill "Name": a diff and a brief
        await panel.evaluate(() => document.fonts.ready)
        // No horizontal scroll at any supported width.
        expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        await panel.setViewportSize({ width: width * 2, height: 2400 })
        await panel.evaluate(() => (document.documentElement.style.zoom = "2"))
        await panel.mouse.move(1, 1) // no stray hover in the docs
        const name = width === 320 ? `sidepanel-${scheme}` : `sidepanel-${width}-${scheme}`
        await panel.locator("main").screenshot({ path: shotPath(`${name}.png`), animations: "disabled" })
        await panel.close()
      }
    }
  })
})
