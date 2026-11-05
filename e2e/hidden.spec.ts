import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserContext, Page } from "@playwright/test"
import { expect, test } from "./fixtures"

// Chrome delivers no real input to a hidden tab (another tab selected in its window, a covered or minimized window).
// Clicks and typing then go as the page's own events. Playwright's Chromium never hides a tab, so the page is made to
// say it is hidden, which is what Kitestring checks.

const find = (context: BrowserContext, end: string): Page => context.pages().find((p) => p.url().endsWith(end))!
const hide = (page: Page) => page.evaluate(() => Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true }))

test.describe("a hidden tab", () => {
  test("a click goes as page events, once, and says so", async ({ kite, torture, context, result }) => {
    await kite("tab", "new", `${torture}/toggle`)
    await hide(find(context, "/toggle"))
    const r = await kite("click", "Notifications")
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain("✓ done (tab hidden: sent as page events; check the page reacted)")
    expect(await result(find(context, "/toggle"))).toBe("flips:1")
  })

  test("a fast batch fills a form and submits it with page events", async ({ kiteStdin, kite, torture, context, result }) => {
    await kite("tab", "new", `${torture}/basic-form`)
    await hide(find(context, "/basic-form"))
    const steps = [
      { action: "fill", target: "Name", value: "Ada" },
      { action: "fill", target: "Email", value: "ada@x.io" },
      { action: "click", target: "Submit" },
    ]
    const r = await kiteStdin(JSON.stringify({ steps, wait_idle: "never" }), "batch", "-")
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain("✓ 1 fill \"Name\" (tab hidden: sent as page events")
    expect(await result(find(context, "/basic-form"))).toBe("submitted:Ada:ada@x.io")
  })

  test("an upload through a button that makes its file input on click opens the chooser with a page click", async ({ kite, torture, context }) => {
    const dir = mkdtempSync(join(tmpdir(), "kitefiles-"))
    try {
      writeFileSync(join(dir, "me.png"), "me.png")
      await kite("tab", "new", `${torture}/file-upload`)
      const page = find(context, "/file-upload")
      await hide(page)
      const r = await kite("upload", "Drop avatar here", join(dir, "me.png"))
      expect(r.code, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain("✓ done (tab hidden: sent as page events")
      expect(r.stdout).toContain("↑ uploaded me.png")
      expect(await page.evaluate(() => (window as unknown as { __cleared?: string }).__cleared)).toBe('{"d":[],"e":["me.png"]}')
      // A CSS selector is not a target: the error says what is.
      const css = await kite("upload", "input[type=file]", join(dir, "me.png"))
      expect(css.stdout).toContain('no element matches "input[type=file]": a target is the element\'s visible text')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a scroll or a key press cannot go as page events: it fails at once, saying why", async ({ kite, torture, context }) => {
    await kite("tab", "new", `${torture}/toggle`)
    await hide(find(context, "/toggle"))
    const t0 = Date.now()
    const r = await kite("scroll", "down")
    expect(r.code).not.toBe(0)
    expect(r.stdout).toContain("the tab is hidden: its window is not on screen")
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect((await kite("press", "Enter")).stdout).toContain("the tab is hidden")
  })
})
