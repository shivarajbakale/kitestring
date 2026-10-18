import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { BrowserContext, Page } from "@playwright/test"
import gifenc from "gifenc"
import pngjs from "pngjs"
import { ROOT } from "./launch.ts"

// Composes README / store images: real screenshots of the page, the side panel and the popup, set in a browser-window
// mock on a brand background. Sources are captured at 2x and the scene is rendered at 1x, so the browser downsamples
// them (crisp text without a 2x-sized file).

// both are CommonJS: Node ESM gives only a default export
const { applyPalette, GIFEncoder, quantize } = gifenc
const { PNG } = pngjs

export const SCALE = 2

/** The demo task: fill the showcase listing, attach two screenshots, then try "Submit for review" (risky: halts). */
export const DEMO_STEPS = [
  { action: "fill", target: "Title", value: "Kitestring" },
  { action: "fill", target: "Summary", value: "Your AI agent drives your real Chrome, and you keep the string." },
  { action: "fill", target: "Description", value: "Agents plan; Kitestring acts with real input events, halts on risky clicks and replays tasks it has seen." },
  { action: "select", target: "Category", value: "Developer Tools" },
  { action: "select", target: "Language", value: "English" },
  { action: "upload", target: "Screenshots", files: [join(ROOT, "brand", "icons", "icon-512.png"), join(ROOT, "brand", "icons", "mark-512.png")] },
  { action: "click", target: "Submit for review" },
]


/** Renders `page` at 2x for its current viewport (Playwright keeps the CSS size; screenshots come out 2x). */
export async function hiDpi(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: SCALE, mobile: false })
}

export async function shot(page: Page): Promise<Buffer> {
  return page.screenshot({ animations: "disabled", caret: "initial" })
}

const font = (file: string) => readFileSync(join(ROOT, "packages", "extension", "ui", "fonts", file)).toString("base64")
const svg = (file: string) => readFileSync(join(ROOT, "brand", file), "utf8").replace(/<\?xml[^>]*>/, "")
const uri = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export interface TermLine {
  text: string
  kind?: "cmd" | "ok" | "halt" | "dim" | "plain"
}

export interface Scene {
  width: number
  height: number
  /** Short line above the window; omitted in the GIF. */
  headline?: string
  kicker?: string
  url: string
  page: { png: Buffer; width: number; height: number }
  /** Docked at the window's right edge, full height. */
  panel?: { png: Buffer; width: number }
  /** Hangs from the toolbar like an open extension popup. */
  popup?: { png: Buffer; width: number; height: number }
  /** A terminal card over the lower left of the page. */
  terminal?: { title: string; lines: TermLine[]; width?: number }
  /** A one- or two-line terminal strip under the window (the GIF caption). */
  strip?: TermLine[]
  /** One flat background colour, no glow or dot grid: a GIF's 256 colours go to the UI instead of the gradient. */
  flat?: boolean
  /** A ring around part of the page (display coordinates), with a short label. */
  callout?: Callout
}

export interface Callout {
  x: number
  y: number
  w: number
  h: number
  label: string
}

function calloutHtml(c: Callout | undefined): string {
  if (!c) return `<div id="callout"></div>`
  return `<div id="callout"><div class="ring" style="left:${c.x - 5}px;top:${BAR + c.y - 5}px;width:${c.w + 10}px;height:${c.h + 10}px"></div><div class="tag" style="left:${c.x + c.w + 5}px;top:${BAR + c.y + c.h + 13}px;transform:translateX(-100%)">${esc(c.label)}</div></div>`
}

const BAR = 44

function termLines(lines: TermLine[]): string {
  return lines
    .map((l) => {
      const k = l.kind ?? (l.text.startsWith("$ ") ? "cmd" : l.text.startsWith("✓") ? "ok" : /^(halted|stopped|✗)/.test(l.text) ? "halt" : "plain")
      const t = k === "cmd" ? `<span class="pr">$</span> ${esc(l.text.replace(/^\$ /, ""))}` : esc(l.text)
      return `<div class="l ${k}">${t || "&nbsp;"}</div>`
    })
    .join("")
}

/** The scene as one HTML document (fonts and logo inlined: nothing is fetched). */
export function sceneHtml(s: Scene): string {
  const winW = s.page.width + (s.panel?.width ?? 0)
  const winH = BAR + s.page.height
  const pop = s.popup
    ? `<div class="popup" style="width:${s.popup.width}px;height:${s.popup.height}px"><img id="popup" src="${uri(s.popup.png)}" width="${s.popup.width}" height="${s.popup.height}"></div>`
    : ""
  const term = s.terminal
    ? `<div class="term card" style="width:${s.terminal.width ?? 470}px"><div class="tbar"><i></i><i></i><i></i><span>${esc(s.terminal.title)}</span></div><div class="tbody">${termLines(s.terminal.lines)}</div></div>`
    : ""
  const strip = s.strip ? `<div class="strip" style="width:${winW}px"><div id="strip">${termLines(s.strip)}</div></div>` : ""
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Geist; src: url(data:font/woff2;base64,${font("Geist-Variable.woff2")}) format("woff2"); font-weight: 100 900 }
@font-face { font-family: "Geist Mono"; src: url(data:font/woff2;base64,${font("GeistMono-Variable.woff2")}) format("woff2"); font-weight: 100 900 }
* { box-sizing: border-box; margin: 0 }
html, body { width: ${s.width}px; height: ${s.height}px; overflow: hidden }
body {
  font-family: Geist, system-ui, sans-serif; color: #f4f2ee; -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(900px 520px at 88% -8%, rgba(214, 59, 31, .50), transparent 62%),
    radial-gradient(760px 480px at -6% 108%, rgba(255, 107, 71, .20), transparent 60%),
    linear-gradient(165deg, #1d1f25 0%, #141519 55%, #101114 100%);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
}
${s.flat ? "body { background: #16181d !important } body::before { display: none } .win, .strip, .card { box-shadow: 0 0 0 1px rgba(255,255,255,.12) !important } .tag { box-shadow: none !important }" : ""}
body::before { content: ""; position: fixed; inset: 0; pointer-events: none;
  background-image: radial-gradient(rgba(255,255,255,.045) 1px, transparent 1px); background-size: 22px 22px;
  mask-image: linear-gradient(180deg, #000, transparent 75%) }
.head { width: ${winW}px; display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; position: relative }
.kicker { font: 600 13px/1 "Geist Mono", monospace; letter-spacing: .08em; text-transform: uppercase; color: #ff8a6e; margin-bottom: 10px }
h1 { font-size: 32px; line-height: 1.12; font-weight: 640; letter-spacing: -.025em; max-width: 820px }
.logo svg { height: 26px; width: auto; display: block; opacity: .95 }
.stage { position: relative }
.win { position: relative; width: ${winW}px; height: ${winH}px; border-radius: 12px; overflow: hidden; background: #fff;
  box-shadow: 0 0 0 1px rgba(255,255,255,.10), 0 30px 80px -20px rgba(0,0,0,.65), 0 12px 30px -12px rgba(0,0,0,.5) }
.bar { height: ${BAR}px; background: #eceef1; border-bottom: 1px solid #d9dce1; display: flex; align-items: center; gap: 14px; padding: 0 14px }
.dots { display: flex; gap: 8px } .dots i { width: 12px; height: 12px; border-radius: 50%; background: #ff5f57; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.15) }
.dots i:nth-child(2) { background: #febc2e } .dots i:nth-child(3) { background: #28c840 }
.nav { display: flex; gap: 12px; color: #8b9099 } .nav svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round }
.url { flex: 1; height: 28px; border-radius: 8px; background: #fff; border: 1px solid #dde0e5; display: flex; align-items: center; gap: 8px; padding: 0 12px;
  font: 450 13px/1 Geist, system-ui, sans-serif; color: #3d424b; max-width: ${Math.max(320, s.page.width - 150)}px }
.url svg { width: 12px; height: 12px; stroke: #8b9099; fill: none; stroke-width: 2.2 }
.ext { margin-left: auto; display: flex; align-items: center; gap: 10px }
.ext .icon { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; background: ${s.popup ? "rgba(214,59,31,.14)" : "transparent"} }
.ext .icon svg { width: 18px; height: 18px }
.body { display: flex; height: ${s.page.height}px }
.body img { display: block }
.panel { border-left: 1px solid #d9dce1 }
.popup { position: absolute; top: ${BAR - 4}px; right: 10px; border-radius: 12px; overflow: hidden; background: #faf9f6;
  box-shadow: 0 0 0 1px rgba(0,0,0,.10), 0 24px 60px -12px rgba(0,0,0,.45), 0 8px 20px -8px rgba(0,0,0,.25) }
.popup img { display: block }
.ring { position: absolute; border: 2.5px solid #ff6b47; border-radius: 12px; box-shadow: 0 0 0 6px rgba(255,107,71,.22) }
.tag { position: absolute; font: 600 12.5px/1 Geist, system-ui, sans-serif; color: #fff; background: #d63b1f; padding: 7px 10px; border-radius: 7px;
  box-shadow: 0 8px 20px -6px rgba(214,59,31,.6); white-space: nowrap }
.card { border-radius: 12px; overflow: hidden; box-shadow: 0 0 0 1px rgba(255,255,255,.10), 0 28px 70px -18px rgba(0,0,0,.7) }
.term { position: absolute; left: -26px; bottom: -26px; background: #0e1013 }
.tbar { height: 32px; display: flex; align-items: center; gap: 7px; padding: 0 12px; background: #181b20; border-bottom: 1px solid #23272e }
.tbar i { width: 10px; height: 10px; border-radius: 50%; background: #3a3f48 }
.tbar span { margin-left: 8px; font: 500 12px/1 "Geist Mono", monospace; color: #8b919b }
.tbody, .strip { font: 450 13.5px/1.6 "Geist Mono", ui-monospace, monospace; color: #d7dae0 }
.tbody { padding: 12px 16px 14px }
.l { white-space: pre-wrap; word-break: break-word }
.l .pr { color: #ff8a6e } .l.cmd { color: #f4f2ee } .l.ok { color: #7fd6a2 } .l.halt { color: #ffc069 } .l.dim { color: #7c828c }
.strip { background: #0e1013; border-radius: 10px; padding: 11px 18px; height: 88px; overflow: hidden;
  box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 18px 40px -16px rgba(0,0,0,.6) }
</style></head><body>
${s.headline ? `<div class="head"><div>${s.kicker ? `<div class="kicker">${esc(s.kicker)}</div>` : ""}<h1>${esc(s.headline)}</h1></div><div class="logo">${svg("lockup-dark.svg")}</div></div>` : ""}
<div class="stage">
<div class="win">
  <div class="bar">
    <div class="dots"><i></i><i></i><i></i></div>
    <div class="nav"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg></div>
    <div class="url"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>${esc(s.url)}</div>
    <div class="ext"><span class="icon">${svg("mark.svg")}</span></div>
  </div>
  <div class="body"><img id="page" src="${uri(s.page.png)}" width="${s.page.width}" height="${s.page.height}">${
    s.panel ? `<img id="panel" class="panel" src="${uri(s.panel.png)}" width="${s.panel.width}" height="${s.page.height}">` : ""
  }</div>
  ${pop}
  ${calloutHtml(s.callout)}
</div>
${term}
</div>
${strip}
</body></html>`
}

/** A page of `context` that renders scenes. */
export async function sceneRenderer(context: BrowserContext, width: number, height: number) {
  const page = await context.newPage()
  await page.setViewportSize({ width, height })
  const ready = () =>
    page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => undefined)))
    })
  return {
    page,
    async render(s: Scene): Promise<Buffer> {
      await page.setContent(sceneHtml(s))
      await ready()
      return page.screenshot({ clip: { x: 0, y: 0, width, height } })
    },
    /** Swaps the images and the strip of the scene already shown (fast: no re-parse of the fonts). */
    async update(u: { page?: Buffer; panel?: Buffer; strip?: TermLine[]; callout?: Callout | null }): Promise<Buffer> {
      await page.evaluate(
        ([p, q, strip, callout]) => {
          if (p) (document.getElementById("page") as HTMLImageElement).src = p
          if (q) (document.getElementById("panel") as HTMLImageElement).src = q
          if (strip !== null) document.getElementById("strip")!.innerHTML = strip
          if (callout !== null) document.getElementById("callout")!.outerHTML = callout
        },
        [u.page ? uri(u.page) : null, u.panel ? uri(u.panel) : null, u.strip ? termLines(u.strip) : null, u.callout === undefined ? null : calloutHtml(u.callout ?? undefined)] as const,
      )
      await ready()
      return page.screenshot({ clip: { x: 0, y: 0, width, height } })
    },
  }
}

/**
 * One GIF from PNG frames: one global palette, and every frame after the first stores only the pixels that changed
 * (the rest are transparent), which keeps a mostly-still screen recording small.
 */
export function encodeGif(frames: { png: Buffer; delay: number }[]): Uint8Array {
  const rgba = frames.map((f) => PNG.sync.read(f.png))
  const { width, height } = rgba[0]!
  // Palette from the first and last frames (start and end state hold every colour that matters), 255 colours + 1 transparent.
  const sample = new Uint8Array(rgba[0]!.data.length * 2)
  sample.set(rgba[0]!.data, 0)
  sample.set(rgba[rgba.length - 1]!.data, rgba[0]!.data.length)
  const palette = quantize(sample, 255)
  while (palette.length < 255) palette.push([0, 0, 0])
  palette.push([0, 0, 0])
  const T = 255
  const gif = GIFEncoder()
  let prev: Uint8Array | null = null
  rgba.forEach((img, i) => {
    const index = applyPalette(img.data, palette)
    let out = index
    if (prev) {
      out = new Uint8Array(index)
      for (let p = 0; p < out.length; p++) if (out[p] === prev[p]) out[p] = T
    }
    gif.writeFrame(out, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: frames[i]!.delay,
      transparent: i > 0,
      transparentIndex: T,
      dispose: 1,
    })
    prev = index
  })
  gif.finish()
  return gif.bytes()
}

/** Drops frames identical to the one before, adding their time to it. */
export function dedupe(frames: { png: Buffer; delay: number }[]): { png: Buffer; delay: number }[] {
  const out: { png: Buffer; delay: number; raw: Buffer }[] = []
  for (const f of frames) {
    const raw = PNG.sync.read(f.png).data
    const last = out[out.length - 1]
    if (last && last.raw.equals(raw)) last.delay += f.delay
    else out.push({ ...f, raw })
  }
  return out.map(({ png, delay }) => ({ png, delay }))
}
