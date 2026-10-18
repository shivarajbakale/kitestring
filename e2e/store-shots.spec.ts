import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EXTENSION_ID } from "@kitestring/protocol"
import type { BrowserContext, Page } from "@playwright/test"
import { expect, test } from "./fixtures"
import { ROOT } from "./launch.ts"
import { DEMO_STEPS, hiDpi, sceneRenderer, shot, type Scene, type TermLine } from "./scene.ts"

// Chrome Web Store screenshots (1280x800) and their README copies: real captures of the showcase page, the side
// panel and the popup, composed in a browser-window mock on the brand background (see scene.ts).
// Only written with KITE_UPDATE_DOCS=1: they share the port and the browser with the other e2e specs.
const STORE = join(ROOT, "store", "screenshots")
const DOCS = join(ROOT, "docs", "screenshots")
const CANVAS = { width: 1280, height: 800 }
/** Captured at this CSS size (2x pixels) and shown at ZOOM in the scene. */
const SITE = { width: 860, height: 650 }
const WIDE = { width: 1180, height: 650 }
const PANEL = 360
const ZOOM = 0.9
const z = (n: number) => Math.round(n * ZOOM)

const FILL = DEMO_STEPS.filter((s) => s.action === "fill" || s.action === "select")

function save(file: string, png: Buffer): void {
  mkdirSync(STORE, { recursive: true })
  mkdirSync(DOCS, { recursive: true })
  writeFileSync(join(STORE, file), png)
  copyFileSync(join(STORE, file), join(DOCS, file))
}

async function openPanel(context: BrowserContext): Promise<Page> {
  const panel = await context.newPage()
  await hiDpi(panel, PANEL, SITE.height)
  await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`)
  await expect(panel.getByText("Connected", { exact: true })).toBeVisible()
  return panel
}

/** Unfolds the newest batch (what a user would do to look at it) and scrolls the log to its last step. */
async function showLatest(panel: Page, steps: number): Promise<void> {
  const batch = panel.locator(".ks-batch").first()
  const head = batch.locator(".ks-batch__head")
  await expect(head).toContainText(`batch · ${steps} steps`)
  if ((await head.getAttribute("aria-expanded")) === "false") await head.evaluate((el: HTMLElement) => el.click())
  await expect(head).toHaveAttribute("aria-expanded", "true")
  await batch.locator(".ks-batch__steps > *").nth(steps - 1).waitFor()
  await panel.evaluate(() => {
    const last = document.querySelector(".ks-batch__steps")?.lastElementChild
    const log = document.querySelector(".panel__log")
    if (!last || !log) return
    const over = last.getBoundingClientRect().bottom - log.getBoundingClientRect().bottom + 8
    log.scrollTop += over
  })
  await panel.waitForTimeout(150)
}

const termOf = (cmd: string, out: string, keep: (l: string) => boolean = () => true): TermLine[] => [
  { text: `$ ${cmd}` },
  ...out
    .trim()
    .split("\n")
    .filter((l) => l && !l.startsWith("+ ") && !l.startsWith("- ") && !l.startsWith("page: ") && keep(l))
    .map((text) => ({ text })),
]

test.describe("store screenshots", () => {
  test.skip(process.env.KITE_UPDATE_DOCS !== "1", "set KITE_UPDATE_DOCS=1 to refresh store/screenshots")

  test("popup, live view, risky halt and a replayed task", async ({ kite, kiteStdin, context, torture }) => {
    test.setTimeout(180_000)
    const url = `${torture}/showcase-listing`
    const host = url.replace(/^https?:\/\//, "")
    const scene = await sceneRenderer(context, CANVAS.width, CANVAS.height)
    const base = (s: Partial<Scene> & Pick<Scene, "page" | "headline" | "kicker">): Scene => ({ ...CANVAS, url: host, ...s })

    // A second agent session, so the popup lists more than one.
    expect((await kite("--session", "claude-code", "tab", "new", `${torture}/basic-form`)).code).toBe(0)
    const other = (await kiteStdin(JSON.stringify([{ action: "fill", target: "Name", value: "Ada" }]), "--session", "claude-code", "batch", "-"))
    expect(other.code, other.stdout + other.stderr).toBe(0)

    // 1. The popup with the Pause switch, open over a page an agent is filling.
    expect((await kite("tab", "new", url)).code).toBe(0)
    const site = context.pages().find((p) => p.url() === url)!
    await hiDpi(site, WIDE.width, WIDE.height)
    const r1 = await kiteStdin(JSON.stringify(FILL.slice(0, 3)), "batch", "-")
    expect(r1.code, r1.stdout + r1.stderr).toBe(0)
    const popup = await context.newPage()
    await popup.setViewportSize({ width: 360, height: 640 })
    await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`)
    await expect(popup.getByText("Connected", { exact: true })).toBeVisible()
    await expect(popup.getByRole("button", { name: /claude-code/ })).toBeVisible()
    const popH = Math.min(600, Math.ceil(await popup.evaluate(() => document.querySelector("main")!.getBoundingClientRect().height)))
    await hiDpi(popup, 360, popH)
    await popup.waitForTimeout(200)
    save(
      "1-popup-pause.png",
      await scene.render(
        base({
          kicker: "You hold the string",
          headline: "Pause every agent with one switch",
          page: { png: await shot(site), width: z(WIDE.width), height: z(WIDE.height) },
          popup: { png: await shot(popup), width: z(360), height: z(popH) },
        }),
      ),
    )
    await popup.close()

    // 2. The side panel next to the page while one batch fills it.
    await hiDpi(site, SITE.width, SITE.height)
    await site.reload()
    const panel = await openPanel(context)
    expect((await kite("memory", "discard")).code).toBe(0) // the remembered task starts here
    const r2 = await kiteStdin(JSON.stringify(FILL), "batch", "-")
    expect(r2.code, r2.stdout + r2.stderr).toBe(0)
    await showLatest(panel, 5)
    const pageAt = { width: z(SITE.width), height: z(SITE.height) }
    save(
      "2-live-view.png",
      await scene.render(
        base({
          kicker: "Live view",
          headline: "Watch each step as your agent takes it",
          page: { png: await shot(site), ...pageAt },
          panel: { png: await shot(panel), width: z(PANEL) },
        }),
      ),
    )

    // Turn what just worked into a remembered task (no values are stored).
    const saved = await kite("memory", "save", "publish the extension listing")
    expect(saved.code, saved.stdout + saved.stderr).toBe(0)
    const id = /plan (\S+)/.exec(saved.stdout)![1]!

    // 3. A risky step halted, waiting for a yes.
    await site.reload()
    const r3 = await kiteStdin(JSON.stringify(DEMO_STEPS), "batch", "-")
    expect(r3.code).toBe(1)
    expect(r3.stdout).toMatch(/halted at step 7 \(risky\)/)
    await showLatest(panel, 7)
    const box = (await site.locator("#submitBtn").boundingBox())!
    save(
      "3-risky-halt.png",
      await scene.render(
        base({
          kicker: "Guards",
          headline: "Risky clicks stop and wait for your yes",
          page: { png: await shot(site), ...pageAt },
          panel: { png: await shot(panel), width: z(PANEL) },
          callout: { x: z(box.x), y: z(box.y), w: z(box.width), h: z(box.height), label: "Halted before the click" },
          terminal: {
            title: "kite batch",
            width: 560,
            lines: termOf("kite batch publish-listing.json", r3.stdout, (l) => !/^(✓ [1-4] |✗ 7 )/.test(l)).flatMap((l, i) =>
              i === 1 ? [{ text: "…", kind: "dim" as const }, l] : [l],
            ),
          },
        }),
      ),
    )

    // 4. The remembered task replayed on a fresh page with one command.
    await site.reload()
    const values: Record<string, string> = Object.fromEntries(FILL.map((s) => [s.target.toLowerCase(), String(s.value)]))
    const args = Object.entries(values).flatMap(([k, v]) => ["--param", `${k}=${v}`])
    const r4 = await kite("run", id, ...args)
    expect(r4.code, r4.stdout + r4.stderr).toBe(0)
    await showLatest(panel, 5)
    const shown = `kite run ${id.split("/")[1]} --param title=Kitestring --param category="Developer Tools" …`
    save(
      "4-replay.png",
      await scene.render(
        base({
          kicker: "Remembered tasks",
          headline: "Replay a task in one command, with no model call",
          page: { png: await shot(site), ...pageAt },
          panel: { png: await shot(panel), width: z(PANEL) },
          terminal: { title: "kite run", width: 560, lines: termOf(shown, r4.stdout) },
        }),
      ),
    )
  })
})
