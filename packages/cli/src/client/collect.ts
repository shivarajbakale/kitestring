import { parseTarget, type ActionResult, type ExtractResult, type Method } from "@kitestring/protocol"
import { KiteError } from "./rpc-client.js"

export type Call = (method: Method, params: Record<string, unknown>) => Promise<unknown>
export type Row = Record<string, unknown>

/** Rows seen so far, by their `id` column's value when they have one, else by every cell. */
export class RowSet {
  private seen = new Set<string>()
  readonly rows: Row[] = []
  constructor(readonly id?: string) {}
  key(r: Row): string {
    const v = this.id !== undefined ? r[this.id] : undefined
    if (v !== undefined && v !== null && v !== "") return `id:${typeof v === "string" ? v : JSON.stringify(v)}`
    return JSON.stringify(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))
  }
  has(r: Row): boolean {
    return this.seen.has(this.key(r))
  }
  /** Adds the rows not seen before; the ones added. */
  add(rows: Row[]): Row[] {
    const fresh: Row[] = []
    for (const r of rows) {
      const k = this.key(r)
      if (this.seen.has(k)) continue
      this.seen.add(k)
      this.rows.push(r)
      fresh.push(r)
    }
    return fresh
  }
  /** Marks rows as seen without keeping them (a resumed job's rows already on disk). */
  remember(rows: Row[]): void {
    for (const r of rows) this.seen.add(this.key(r))
  }
  get size(): number {
    return this.seen.size
  }
}

/**
 * Runs in the page: reads `fields` from each element matching `items`. A field is `css` (its visible text), `css@attr`
 * (an attribute; links and images made absolute), `@attr` or `.` (the item itself). Also the point over the box the
 * items scroll in, when that box is not the page. Self-contained: its source is sent with page.eval.
 */
export function readListInPage(items: string, fields: Record<string, string>, max: number) {
  const abs = (v: string) => {
    try {
      return new URL(v, document.baseURI).href
    } catch {
      return v
    }
  }
  const one = (root: Element, spec: string): string => {
    const m = /^(.*?)@([\w:-]+)$/.exec(spec.trim())
    const css = (m ? m[1]! : spec).trim()
    const el = !css || css === "." ? root : root.querySelector(css)
    if (!el) return ""
    if (m) {
      const v = el.getAttribute(m[2]!) ?? ""
      return /^(href|src|action|data-href)$/i.test(m[2]!) && v ? abs(v) : v.trim()
    }
    // Icon fonts draw with private-use characters (a phone glyph before the number): not text.
    return ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim()
  }
  const els = Array.from(document.querySelectorAll(items))
  const rows = els.slice(0, max).map((el) => {
    const r: Record<string, string> = {}
    for (const [k, s] of Object.entries(fields)) r[k] = one(el, s)
    return r
  })
  let scrollAt: { x: number; y: number } | undefined
  // Whether the box the items scroll in (else the page) is scrolled to its bottom: no more to scroll to.
  const se = document.scrollingElement ?? document.documentElement
  let atEnd = se.scrollTop + innerHeight >= se.scrollHeight - 2
  for (let box = els[0]?.parentElement ?? null; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
    if (box.scrollHeight <= box.clientHeight + 1 || !/(auto|scroll|overlay)/.test(getComputedStyle(box).overflowY)) continue
    atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2
    const b = box.getBoundingClientRect()
    const x = Math.round((Math.max(0, b.left) + Math.min(innerWidth, b.right)) / 2)
    const y = Math.round((Math.max(0, b.top) + Math.min(innerHeight, b.bottom)) / 2)
    const hit = document.elementFromPoint(x, y)
    if (hit && box.contains(hit)) scrollAt = { x, y }
    break
  }
  return { rows, total: els.length, atEnd, ...(scrollAt ? { scrollAt } : {}) }
}

/**
 * The source of a function `(doc, url) => row` reading `fields` from a whole document (a detail page), as for a list
 * item but rooted at the document. Plus `auto` fields when asked: a page's title, phones, emails, address and its
 * JSON-LD's plain values, which suit contact and product pages.
 */
export function fieldsReader(fields: Record<string, string> | "auto"): string {
  const auto = fields === "auto"
  const f = auto ? {} : fields
  return `(doc, url) => {
    const abs = (v) => { try { return new URL(v, url || doc.baseURI).href } catch { return v } }
    const one = (spec) => {
      const m = /^(.*?)@([\\w:-]+)$/.exec(spec.trim())
      const css = (m ? m[1] : spec).trim()
      const el = !css || css === "." ? doc.documentElement : doc.querySelector(css)
      if (!el) return ""
      if (m) { const v = el.getAttribute(m[2]) || ""; return /^(href|src|action|data-href)$/i.test(m[2]) && v ? abs(v) : v.trim() }
      return (el.innerText || el.textContent || "").replace(/[\\uE000-\\uF8FF]/g, "").replace(/\\s+/g, " ").trim()
    }
    const out = {}
    for (const [k, s] of Object.entries(${JSON.stringify(f)})) out[k] = one(s)
    if (${auto}) {
      const text = (doc.body && (doc.body.innerText || doc.body.textContent)) || ""
      const uniq = (xs) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))]
      out.title = one("h1") || doc.title
      const desc = doc.querySelector('meta[name="description"],meta[property="og:description"]')
      if (desc) out.description = desc.getAttribute("content") || ""
      const tels = uniq([...doc.querySelectorAll('a[href^="tel:"]')].map((a) => decodeURIComponent(a.getAttribute("href").slice(4))))
      const phones = tels.length ? tels : uniq(text.match(/(?:\\+\\d{1,3}[\\s.-]?)?(?:\\(\\d{2,5}\\)[\\s.-]?)?\\d{2,5}[\\s.-]\\d{3,5}(?:[\\s.-]\\d{2,5})?/g) || []).slice(0, 3)
      out.phone = phones.join("; ")
      const mails = uniq([...doc.querySelectorAll('a[href^="mailto:"]')].map((a) => a.getAttribute("href").slice(7).split("?")[0]).concat(text.match(/[\\w.+-]+@[\\w-]+\\.[\\w.-]+/g) || []))
      out.email = mails.slice(0, 3).join("; ")
      const addr = doc.querySelector("address,[itemprop=address]")
      if (addr) out.address = (addr.innerText || addr.textContent || "").replace(/\\s+/g, " ").trim()
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let v; try { v = JSON.parse(s.textContent || "") } catch { continue }
        const e = Array.isArray(v) ? v[0] : v && v["@graph"] ? v["@graph"][0] : v
        if (!e || typeof e !== "object") continue
        for (const [k, x] of Object.entries(e)) {
          if (k.startsWith("@") || out[k] !== undefined) continue
          if (typeof x === "string" || typeof x === "number") out[k] = String(x)
          else if (x && typeof x === "object" && !Array.isArray(x)) {
            const flat = Object.entries(x).filter(([kk, xx]) => !kk.startsWith("@") && (typeof xx === "string" || typeof xx === "number")).map(([, xx]) => xx)
            if (flat.length) out[k] = flat.join(", ")
          }
        }
        break
      }
    }
    return out
  }`
}

export interface CollectOpts {
  /** CSS selector of the items, one row each. Needed with `fields`; else the list `extract` picks (or `near` names). */
  items?: string
  near?: string
  /** Name -> field (see readListInPage); without it, the columns `extract` finds. */
  fields?: Record<string, string>
  /** "scroll" (the page, or the list's own panel), or the visible text of a next button; none: this page only. */
  more?: string | null
  limit?: number
  id?: string
  /** At most this many scrolls or next pages. */
  rounds?: number
  /** After a scroll or a next click, new rows are waited for this long. */
  waitMs?: number
}

export interface CollectHooks {
  /** Rows found for the first time, as they come (a job writes them out). */
  onRows?: (rows: Row[]) => void
  /** Epoch ms to stop by. */
  deadline?: number
  /** Before each scroll or click: a job waits there for its window to be visible. */
  beforeInput?: () => Promise<void>
  sleep?: (ms: number) => Promise<void>
  /** Rows already kept (a resumed job): they are not new again. */
  seen?: RowSet
}

export interface Collected {
  rows: Row[]
  rounds: number
  stopped: string
}

export const COLLECT_MAX_ROWS = 50_000
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Reads a list, then scrolls (or clicks next) and reads it again until no new rows come, the limit, the rounds or the
 * deadline. Rows are kept once (by `id`, else by every cell), so a list that reuses its elements as it scrolls
 * (a virtual list) is read whole.
 */
export async function collectList(call: Call, o: CollectOpts, h: CollectHooks = {}): Promise<Collected> {
  if (o.fields && !o.items) throw new KiteError("BAD_REQUEST", "collect: fields need items (the CSS selector of one row)")
  const limit = Math.min(COLLECT_MAX_ROWS, o.limit ?? 1_000)
  const rounds = Math.min(2_000, o.rounds ?? 300)
  const waitMs = o.waitMs ?? 4_000
  const sleep = h.sleep ?? sleepMs
  const set = new RowSet(o.id)
  if (h.seen) set.remember(h.seen.rows)
  const found: Row[] = []
  let key: string | undefined
  let scrollAt: { x: number; y: number } | undefined
  let atEnd: boolean | undefined
  const read = async (): Promise<Row[]> => {
    if (o.fields) {
      // As JSON text: a value returned by value loses its keys' order, which is the columns' order.
      const expr = `JSON.stringify((${readListInPage.toString()})(${JSON.stringify(o.items)}, ${JSON.stringify(o.fields)}, ${COLLECT_MAX_ROWS}))`
      const text = ((await call("page.eval", { expression: expr })) as { value?: string }).value
      const r = text ? (JSON.parse(text) as { rows: Row[]; atEnd?: boolean; scrollAt?: { x: number; y: number } }) : undefined
      if (r?.scrollAt) scrollAt = r.scrollAt
      atEnd = r?.atEnd
      return r?.rows ?? []
    }
    const r = (await call("page.extract", {
      ...(o.items ? { selector: o.items } : key ? { key } : o.near ? { near: o.near } : {}),
      max: 5_000,
    })) as ExtractResult
    key ??= r.key
    if (r.scrollAt) scrollAt = r.scrollAt
    return r.rows
  }
  const take = (rows: Row[]): number => {
    const fresh = set.add(rows.filter((r) => Object.values(r).some((v) => v !== "" && v !== undefined)))
    const room = fresh.slice(0, Math.max(0, limit - found.length))
    found.push(...room)
    if (room.length) h.onRows?.(room)
    return room.length
  }
  take(await read())
  let round = 0
  let stopped = "one page (no more)"
  if (o.more) {
    stopped = ""
    let dry = 0
    while (!stopped) {
      if (found.length >= limit) stopped = `reached ${limit} rows`
      else if (round >= rounds) stopped = `after ${rounds} rounds`
      else if (h.deadline && Date.now() > h.deadline - 5_000) stopped = "out of time"
      if (stopped) break
      await h.beforeInput?.()
      if (o.more === "scroll") {
        await call("act.scroll", { direction: "down", px: 2_500, ...(scrollAt ? { at: scrollAt } : {}) })
      } else {
        let r: ActionResult | null
        try {
          r = (await call("act.click", { target: parseTarget(o.more) })) as ActionResult | null
        } catch (e) {
          if (e instanceof KiteError && (e.code === "BAD_REQUEST" || e.code === "TIMEOUT")) {
            stopped = `no next page (${e.message.split("\n")[0]})`
            break
          }
          throw e
        }
        if (r && r.ok === false) {
          stopped = `no next page (${r.status}${r.detail ? `: ${r.detail.split("\n")[0]}` : ""})`
          break
        }
      }
      round++
      let added = 0
      for (let waited = 0; ; waited += 500) {
        try {
          added = take(await read())
        } catch (e) {
          if (!(e instanceof KiteError && e.code === "BAD_REQUEST")) throw e
        }
        if (added || waited >= waitMs) break
        await sleep(500)
      }
      // A lazy list can need a second scroll before it loads more; two dry rounds in a row is the end (one when the
      // list is already scrolled to its bottom).
      if (added) dry = 0
      else if (++dry >= (o.more === "scroll" && !atEnd ? 2 : 1)) stopped = `no new rows after ${o.more === "scroll" ? "scrolling" : "the next page"}`
    }
  }
  return { rows: found, rounds: round, stopped }
}

export interface ReadEachOpts {
  /** Tabs read at once (tab mode) or requests in flight (fetch mode); 1..8. */
  concurrency?: number
  /** "tab": open each in a background tab (pages that build themselves with JavaScript); "fetch": download its HTML. */
  mode?: "tab" | "fetch"
  /** Before reading, wait for this CSS selector (or a waitFor condition) to be on the page. */
  wait?: string | Record<string, unknown>
  /** Per page, in ms. */
  timeoutMs?: number
  /** Pause between two pages of one worker, in ms (be gentle with the site). */
  delayMs?: number
}

export interface ReadEachHooks {
  /** A call in the worker's own session (its own tab); `n` from 1. */
  worker: (n: number) => Call
  /** The main session's call (fetch mode reads through its tab). */
  main: Call
  onRow?: (row: Row, i: number) => void
  deadline?: number
  sleep?: (ms: number) => Promise<void>
  /** URLs already read (a resumed job). */
  skip?: (url: string) => boolean
}

/** A reader's value, sent as JSON text so its keys keep their order. */
const parsed = (text: string | undefined): unknown => (typeof text === "string" ? JSON.parse(text) : undefined)

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!

/**
 * Reads every URL with `fn` (source of `(doc, url) => value`, run in the page): in background tabs of worker sessions,
 * or by fetching the HTML in the main tab (same cookies). An object value gets the URL as `url` when it has none.
 * A page that fails gives `{url, error}`; the run stops when the first five all fail (the reader is wrong).
 */
export async function readEach(urls: string[], fn: string, o: ReadEachOpts, h: ReadEachHooks): Promise<Row[]> {
  const list = urls.filter((u) => typeof u === "string" && /^https?:\/\//.test(u))
  if (list.length !== urls.length) throw new KiteError("BAD_REQUEST", `readEach: every url must be an http(s) URL (${urls.length - list.length} are not)`)
  const concurrency = Math.max(1, Math.min(8, o.concurrency ?? 3))
  const mode = o.mode ?? "tab"
  const timeoutMs = Math.max(2_000, Math.min(120_000, o.timeoutMs ?? 20_000))
  const delayMs = Math.max(0, o.delayMs ?? 300)
  const sleep = h.sleep ?? sleepMs
  const out: Row[] = new Array(list.length)
  let next = 0
  let failed = 0
  let done = 0
  let stop: Error | undefined
  const cond = o.wait === undefined ? undefined : typeof o.wait === "string" ? { selector: o.wait, state: "attached" } : o.wait
  const shape = (url: string, v: unknown): Row =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? ("url" in (v as object) ? (v as Row) : { url, ...(v as Row) }) : { url, value: v }
  const worker = async (n: number) => {
    const c = mode === "tab" ? h.worker(n) : h.main
    let opened = false
    try {
      while (!stop) {
        const i = next++
        if (i >= list.length) break
        const url = list[i]!
        if (h.skip?.(url)) continue
        // Out of time: what was read is kept (and already handed to onRow); the rest is left for a resumed run.
        if (h.deadline && Date.now() > h.deadline - 5_000) break
        let row: Row
        try {
          if (mode === "fetch") {
            const expr = `(async (url) => { const r = await fetch(url, { credentials: "include" }); if (!r.ok) throw new Error("HTTP " + r.status); const doc = new DOMParser().parseFromString(await r.text(), "text/html"); const b = doc.createElement("base"); b.href = url; doc.head.prepend(b); return JSON.stringify(await (${fn})(doc, url)) })(${JSON.stringify(url)})`
            row = shape(url, parsed(((await c("page.eval", { expression: expr })) as { value?: string }).value))
          } else {
            if (!opened) {
              await c("tab.new", { url, background: true })
              opened = true
            } else {
              const r = (await c("act.batch", { steps: [{ action: "goto", url }], wait_idle: "never", budget_ms: timeoutMs })) as { ok: boolean; halted?: { detail?: string } }
              if (!r.ok) throw new Error(`could not open: ${r.halted?.detail ?? "navigation failed"}`)
            }
            if (cond) {
              try {
                await c("page.wait", { cond, timeout_ms: timeoutMs })
              } catch (e) {
                if (!(e instanceof KiteError && e.code === "TIMEOUT")) throw e
                // Read what is there: the reader says what is missing.
              }
            }
            const expr = `(async () => JSON.stringify(await (${fn})(document, ${JSON.stringify(url)})))()`
            row = shape(url, parsed(((await c("page.eval", { expression: expr })) as { value?: string }).value))
          }
        } catch (e) {
          if (e instanceof KiteError && (e.code === "PAUSED" || e.code === "NOT_CONNECTED" || e.code === "STOPPED")) {
            stop = e
            break
          }
          failed++
          row = { url, error: message(e) }
        }
        out[i] = row
        done++
        h.onRow?.(row, i)
        if (done === Math.min(5, list.length) && failed === done && done > 1) {
          stop = new KiteError("BAD_REQUEST", `readEach: the first ${done} pages all failed (last: ${row.error}); check the reader on one page`)
          break
        }
        if (delayMs) await sleep(delayMs)
      }
    } finally {
      if (opened) await c("tab.close", {}).catch(() => {})
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, (_, k) => worker(k + 1)))
  if (stop) throw stop
  return out.filter((r) => r !== undefined)
}
