import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { EXTENSION_ID } from "@kitestring/protocol"
import { expect, test } from "./fixtures"
import { ROOT } from "./launch.ts"
import { DEMO_STEPS, dedupe, encodeGif, hiDpi, sceneRenderer, shot, type TermLine } from "./scene.ts"

// Records docs/demo.gif: the showcase listing page in a browser-window mock with the Kitestring side panel docked
// beside it, while ONE `kite batch` fills the form and then halts before the risky "Submit for review".
// Only with KITE_UPDATE_DOCS=1 (it shares the port and browser with the rest of e2e).
const OUT = join(ROOT, "docs", "demo.gif")
const MAX_BYTES = 4 * 1024 * 1024
const SITE = { width: 780, height: 616 }
const PANEL = 340
const CANVAS = { width: 1240, height: 840 }


test.describe("demo gif", () => {
  test.skip(process.env.KITE_UPDATE_DOCS !== "1", "set KITE_UPDATE_DOCS=1 to refresh docs/demo.gif")

  test("one batch fills the showcase listing and halts before Submit for review", async ({ kite, kiteStdin, context, torture }) => {
    test.setTimeout(180_000)
    const url = `${torture}/showcase-listing`
    expect((await kite("tab", "new", url)).code).toBe(0)
    const site = context.pages().find((p) => p.url() === url)!
    await hiDpi(site, SITE.width, SITE.height)
    const panel = await context.newPage()
    await hiDpi(panel, PANEL, SITE.height)
    await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`)
    await expect(panel.getByText("Connected", { exact: true })).toBeVisible()

    const cmd: TermLine = { text: "$ kite batch publish-listing.json" }
    const scene = await sceneRenderer(context, CANVAS.width, CANVAS.height)
    const pair = async () => Promise.all([shot(site), shot(panel)])

    // Raw captures first (fast), composed afterwards, so the frame times are the real ones.
    const raw: { site: Buffer; panel: Buffer; t: number; strip: TermLine[] }[] = []
    const grab = async (strip: TermLine[]) => {
      // Past 5 steps the panel folds a batch; unfold it (as a user would) and follow its newest step.
      await panel.evaluate(() => {
        const head = document.querySelector<HTMLButtonElement>(".ks-batch__head[aria-expanded=false]")
        head?.click()
        // Scroll only the activity log (the pause switch stays in view, as in the real panel).
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
          if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight
        }
      })
      const t = Date.now()
      const [a, b] = await pair()
      raw.push({ site: a, panel: b, t, strip })
    }
    const idle: TermLine[] = [{ text: "$ ", kind: "cmd" }]
    await grab(idle)
    let done = false
    const typed: TermLine[] = [cmd, { text: "running 7 steps under one tab lock …", kind: "dim" }]
    await grab(typed)
    raw[1]!.t -= 600
    const run = kiteStdin(JSON.stringify(DEMO_STEPS), "batch", "-").finally(() => (done = true))
    while (!done && raw.length < 120) await grab(typed)
    const r = await run
    expect(r.code, r.stdout + r.stderr).toBe(1)
    expect(r.stdout).toMatch(/halted at step 7 \(risky\)/)
    const halted = r.stdout.split("\n").find((l) => l.startsWith("halted at"))!
    const end: TermLine[] = [cmd, { text: halted, kind: "halt" }]
    const box = (await site.locator("#submitBtn").boundingBox())!
    const callout = { x: box.x, y: box.y, w: box.width, h: box.height, label: "Halted before the click: risky" }
    for (let i = 0; i < 4; i++) {
      await new Promise((res) => setTimeout(res, 250))
      await grab(end)
    }
    const doneAt = raw.length - 4

    const first = raw[0]!
    await scene.render({
      width: CANVAS.width,
      height: CANVAS.height,
      url: url.replace(/^https?:\/\//, ""),
      page: { png: first.site, ...SITE },
      panel: { png: first.panel, width: PANEL },
      strip: first.strip,
      flat: true,
    })
    const frames: { png: Buffer; delay: number }[] = []
    for (let i = 0; i < raw.length; i++) {
      const f = raw[i]!
      const next = raw[i + 1]
      const delay = i === 0 ? 1500 : next ? Math.max(100, next.t - f.t) : 4500
      const ring = i >= doneAt ? callout : null
      frames.push({ png: await scene.update({ page: f.site, panel: f.panel, strip: f.strip, callout: ring ?? undefined }), delay })
    }
    const bytes = encodeGif(dedupe(frames))
    expect(bytes.length, "demo.gif must stay under 4 MB").toBeLessThanOrEqual(MAX_BYTES)
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, bytes)
    if (process.env.KITE_DEMO_FRAMES) {
      // Debug aid: the composed frames as PNGs, to look at without a GIF viewer.
      mkdirSync(process.env.KITE_DEMO_FRAMES, { recursive: true })
      frames.forEach((f, i) => writeFileSync(join(process.env.KITE_DEMO_FRAMES!, `${String(i).padStart(3, "0")}.png`), f.png))
    }
  })
})
