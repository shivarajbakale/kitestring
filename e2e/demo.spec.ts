import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { EXTENSION_ID } from "@kitestring/protocol"
import { applyPalette, GIFEncoder, quantize } from "gifenc"
import { PNG } from "pngjs"
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures"

// Records docs/demo.gif: the side panel next to the store-listing page while ONE batch fills the form.
// Only with KITE_UPDATE_DOCS=1 (it shares the port and browser with the rest of e2e).
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "demo.gif")
const MAX_BYTES = 3 * 1024 * 1024
const SITE = { width: 760, height: 520 }
const PANEL = { width: 360, height: 520 }

async function frame(site: Page, panel: Page): Promise<PNG[]> {
  const [a, b] = await Promise.all([site.screenshot(), panel.screenshot()])
  return [PNG.sync.read(a), PNG.sync.read(b)]
}

/** Side-by-side RGBA of the two screenshots. */
function join2(left: PNG, right: PNG): { data: Uint8Array; width: number; height: number } {
  const width = left.width + right.width
  const height = Math.max(left.height, right.height)
  const data = new Uint8Array(width * height * 4).fill(255)
  const blit = (img: PNG, x0: number) => {
    for (let y = 0; y < img.height; y++) {
      data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * width + x0) * 4)
    }
  }
  blit(left, 0)
  blit(right, left.width)
  return { data, width, height }
}

test.describe("demo gif", () => {
  test.skip(process.env.KITE_UPDATE_DOCS !== "1", "set KITE_UPDATE_DOCS=1 to refresh docs/demo.gif")

  test("side panel and store listing while one batch runs", async ({ kite, kiteStdin, context, torture }) => {
    const url = `${torture}/store-listing`
    expect((await kite("tab", "new", url)).code).toBe(0)
    const site = context.pages().find((p) => p.url() === url)!
    await site.setViewportSize(SITE)
    const panel = await context.newPage()
    await panel.setViewportSize(PANEL)
    await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`)

    const frames: { data: Uint8Array; width: number; height: number }[] = []
    const grab = async () => {
      const [l, r] = await frame(site, panel)
      frames.push(join2(l!, r!))
    }
    await grab()
    const steps = [
      { action: "fill", target: "Title", value: "Kitestring" },
      { action: "fill", target: "Summary", value: "Let your AI agent drive your real Chrome, fast." },
      { action: "fill", target: "Description", value: "Agents plan; Kitestring acts, remembers and replays." },
      { action: "select", target: "Category", value: "Developer Tools" },
      { action: "select", target: "Language", value: "English" },
      { action: "click", target: "Privacy", role: "tab" },
      { action: "fill", target: "Single purpose", value: "Browser automation for the user's AI agent" },
      { action: "fill", target: "debugger justification", value: "Real input events and page snapshots" },
      { action: "fill", target: "nativeMessaging justification", value: "Talks to the local kite program" },
      { action: "fill", target: "tabs justification", value: "One tab group per agent session" },
      { action: "fill", target: "host permissions justification", value: "Acts on any page the user opens" },
      { action: "click", target: "Does not collect user data" },
    ]
    let done = false
    const run = kiteStdin(JSON.stringify(steps), "batch", "-").finally(() => (done = true))
    while (!done && frames.length < 40) await grab()
    const r = await run
    expect(r.code, r.stdout + r.stderr).toBe(0)
    await grab()
    await grab()

    const gif = GIFEncoder()
    frames.forEach((f, i) => {
      const palette = quantize(f.data, 256)
      const last = i === frames.length - 1
      gif.writeFrame(applyPalette(f.data, palette), f.width, f.height, { palette, delay: last ? 2500 : 220 })
    })
    gif.finish()
    const bytes = gif.bytes()
    expect(bytes.length, "demo.gif must stay under 3 MB").toBeLessThanOrEqual(MAX_BYTES)
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, bytes)
  })
})
