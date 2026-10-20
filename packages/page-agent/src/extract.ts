/**
 * Repeated data on a page as rows: a table (headers become columns), or a list of items that share their markup
 * (product cards, search results, issue rows), whose text parts line up into columns by where they sit in the item.
 */

import type { ExtractResult } from "@kitestring/protocol"

export type { ExtractCandidate, ExtractResult } from "@kitestring/protocol"

export interface ExtractOpts {
  /** Choose the candidate holding this text (case-folded), e.g. a value seen in one row. */
  near?: string
  /** CSS selector of the items, one row each (columns found as for a list). Wins over `near` and `key`. */
  selector?: string
  /** A `key` from an earlier result: the same table or list on the next page. */
  key?: string
  /** Index into the ranked candidates (0, the best, by default). */
  pick?: number
  /** At most this many rows. */
  max?: number
}

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "IFRAME"])
const MAX_COLUMNS = 20
const MAX_CELL = 1_000
const MIN_ITEMS = 3

const clean = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > MAX_CELL ? `${t.slice(0, MAX_CELL - 1)}…` : t
}
const fold = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase()

/** Class names that say what something is ("price", "title"), not how it looks or a build hash. */
function meaningfulClasses(el: Element): string[] {
  return Array.from(el.classList).filter((c) => /^[a-z][a-z-_]{2,30}$/i.test(c) && !/\d{2}|^(css|sc|jsx|tw|is|has|js)-/i.test(c) && !/^(flex|grid|block|hidden|row|col|container|wrapper|inner|outer|clearfix|relative|absolute|active|selected)$/i.test(c))
}

/** Tag plus up to two meaningful classes: how items of one list look alike. */
function signature(el: Element): string {
  const cls = meaningfulClasses(el).sort().slice(0, 2)
  return el.tagName.toLowerCase() + cls.map((c) => `.${c}`).join("")
}

function hidden(el: Element): boolean {
  if (SKIP.has(el.tagName.toUpperCase()) || el.getAttribute("aria-hidden") === "true") return true
  if (!(el instanceof HTMLElement)) return false
  return el.getClientRects().length === 0
}

function absUrl(doc: Document, v: string | null): string {
  if (!v) return ""
  try {
    return new URL(v, doc.baseURI).href
  } catch {
    return v
  }
}

interface Candidate {
  key: string
  source: string
  items: Element[]
  score: number
  table?: HTMLTableElement | Element
  text: string
}

// ---- tables

function tableRows(t: Element): Element[] {
  if (t instanceof HTMLTableElement) return Array.from(t.rows).filter((r) => !hidden(r))
  return Array.from(t.querySelectorAll('[role="row"]')).filter((r) => !hidden(r))
}

function cellsOf(row: Element): Element[] {
  if (row instanceof HTMLTableRowElement) return Array.from(row.cells)
  return Array.from(row.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]'))
}

const isHeaderRow = (row: Element): boolean => {
  const cells = cellsOf(row)
  return cells.length > 0 && cells.every((c) => c.tagName === "TH" || c.getAttribute("role") === "columnheader")
}

function tableExtract(doc: Document, t: Element, max: number): { columns: string[]; rows: Record<string, string>[]; total: number } {
  const all = tableRows(t)
  const headRow = all.find(isHeaderRow)
  const width = Math.max(0, ...all.map((r) => cellsOf(r).length))
  const names = uniqueNames(Array.from({ length: width }, (_, i) => clean((headRow && cellsOf(headRow)[i]?.textContent) || "") || `column ${i + 1}`))
  const body = all.filter((r) => r !== headRow && !isHeaderRow(r) && cellsOf(r).some((c) => clean(c.textContent ?? "")))
  let link = false
  const rows = body.slice(0, max).map((r) => {
    const rec: Record<string, string> = {}
    cellsOf(r).forEach((c, i) => {
      if (i < names.length) rec[names[i]!] = clean((c as HTMLElement).innerText ?? c.textContent ?? "")
    })
    const a = r.querySelector("a[href]")
    if (a) {
      rec.link = absUrl(doc, a.getAttribute("href"))
      link = true
    }
    return rec
  })
  const columns = link && !names.includes("link") ? [...names, "link"] : names
  return { columns, rows, total: body.length }
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const k = n.toLowerCase()
    const c = (seen.get(k) ?? 0) + 1
    seen.set(k, c)
    return c === 1 ? n : `${n} ${c}`
  })
}

// ---- lists

interface Part {
  path: string
  name: string
  value: string
}

/** The item's text pieces, links and images, each with its path inside the item (how columns line up). */
function partsOf(doc: Document, item: Element): Part[] {
  const out: Part[] = []
  const walk = (el: Element, path: string): void => {
    if (hidden(el)) return
    const tag = el.tagName.toLowerCase()
    if (tag === "a" && el.getAttribute("href")) out.push({ path: `${path}@href`, name: "link", value: absUrl(doc, el.getAttribute("href")) })
    if (tag === "img") {
      const src = el.getAttribute("src") || el.getAttribute("data-src")
      if (src && !src.startsWith("data:")) out.push({ path: `${path}@src`, name: "image", value: absUrl(doc, src) })
    }
    let own = ""
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) own += n.textContent
    own = clean(own)
    if (own) out.push({ path, name: nameFor(el), value: own })
    const counts = new Map<string, number>()
    for (const c of Array.from(el.children)) {
      const s = signature(c)
      const i = counts.get(s) ?? 0
      counts.set(s, i + 1)
      walk(c, `${path}/${s}${i ? `[${i}]` : ""}`)
    }
  }
  walk(item, "")
  return out
}

function nameFor(el: Element): string {
  const aria = el.getAttribute("aria-label") ?? el.getAttribute("itemprop") ?? el.getAttribute("data-testid")
  if (aria && aria.length <= 30) return clean(aria).toLowerCase()
  const cls = meaningfulClasses(el)[0]
  if (cls) return cls.replace(/[-_]+/g, " ").toLowerCase()
  const tag = el.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) return "title"
  return tag === "a" ? "link text" : "text"
}

function listExtract(doc: Document, items: Element[], max: number): { columns: string[]; rows: Record<string, string>[]; total: number } {
  const parts = items.map((it) => partsOf(doc, it))
  // A path is a column when enough items have it (a part only one item has is noise, unless there are few).
  const freq = new Map<string, { n: number; name: string; order: number }>()
  let order = 0
  for (const ps of parts) {
    const seen = new Set<string>()
    for (const p of ps) {
      if (seen.has(p.path)) continue
      seen.add(p.path)
      const f = freq.get(p.path) ?? { n: 0, name: p.name, order: order++ }
      f.n++
      freq.set(p.path, f)
    }
  }
  const need = Math.max(1, Math.ceil(items.length * 0.2))
  const cols = [...freq.entries()].filter(([, f]) => f.n >= need).sort((a, b) => a[1].order - b[1].order).slice(0, MAX_COLUMNS)
  const names = uniqueNames(cols.map(([, f]) => f.name))
  const colOf = new Map(cols.map(([path], i) => [path, names[i]!]))
  const rows: Record<string, string>[] = []
  for (const ps of parts) {
    const rec: Record<string, string> = {}
    for (const p of ps) {
      const c = colOf.get(p.path)
      if (c && rec[c] === undefined) rec[c] = p.value
    }
    if (Object.keys(rec).length) rows.push(rec)
  }
  return { columns: names, rows: rows.slice(0, max), total: rows.length }
}

// ---- finding candidates

const IN_CHROME = 'nav,header,footer,[role="navigation"],[role="banner"],[role="contentinfo"],[role="menu"],[role="menubar"],[role="tablist"]'

function textLen(el: Element): number {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().length
}

function candidates(doc: Document): Candidate[] {
  const out: Candidate[] = []
  const body = doc.body
  if (!body) return out
  const inTable = new Set<Element>()
  for (const t of Array.from(body.querySelectorAll('table,[role="table"],[role="grid"],[role="treegrid"]'))) {
    if (hidden(t) || t.parentElement?.closest('table,[role="table"],[role="grid"]')) continue
    const rows = tableRows(t).filter((r) => !isHeaderRow(r))
    if (rows.length < 1) continue
    // A layout table (one cell per row) is not data.
    if (Math.max(0, ...rows.map((r) => cellsOf(r).length)) < 2) continue
    for (const r of rows) inTable.add(r)
    const head = tableRows(t).find(isHeaderRow)
    const heads = head ? cellsOf(head).map((c) => clean(c.textContent ?? "")).filter(Boolean) : []
    const caption = clean(t.querySelector("caption")?.textContent ?? t.getAttribute("aria-label") ?? "")
    out.push({
      key: `table:${heads.join("|") || signature(t)}`,
      source: `table${caption ? ` ${JSON.stringify(caption)}` : ""} (${rows.length} rows${heads.length ? `: ${heads.slice(0, 4).join(", ")}${heads.length > 4 ? ", …" : ""}` : ""})`,
      items: rows,
      score: rows.length * 3 * Math.sqrt(Math.max(1, textLen(t) / rows.length)) * (t.closest(IN_CHROME) ? 0.2 : 1),
      table: t,
      text: fold(t.textContent ?? ""),
    })
  }
  for (const parent of Array.from(body.querySelectorAll("*"))) {
    if (parent.children.length < MIN_ITEMS || SKIP.has(parent.tagName.toUpperCase()) || parent.tagName === "TBODY" || parent.tagName === "TR" || parent.tagName === "THEAD") continue
    if (hidden(parent)) continue
    const groups = new Map<string, Element[]>()
    for (const c of Array.from(parent.children)) {
      if (hidden(c) || inTable.has(c)) continue
      const s = signature(c)
      groups.set(s, [...(groups.get(s) ?? []), c])
    }
    for (const [sig, items] of groups) {
      if (items.length < MIN_ITEMS) continue
      const lens = items.map(textLen)
      const filled = lens.filter((n) => n > 0).length
      if (filled < MIN_ITEMS) continue
      const avg = lens.reduce((a, b) => a + b, 0) / items.length
      // Items with more parts are records (cards, rows); single words are menus and tags.
      const depth = Math.min(6, items[0]!.querySelectorAll("*").length + 1)
      const chrome = parent.closest(IN_CHROME) ? 0.2 : 1
      const score = filled * Math.sqrt(avg) * Math.sqrt(depth) * chrome
      const ptag = signature(parent)
      out.push({
        key: `list:${ptag}>${sig}`,
        source: `list of ${items.length} ${sig}${parent.id ? ` in #${parent.id}` : ""}`,
        items,
        score,
        text: fold(items.map((i) => i.textContent ?? "").join(" ")),
      })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

function fromSelector(doc: Document, selector: string): Candidate {
  let items: Element[]
  try {
    items = Array.from(doc.querySelectorAll(selector)).filter((e) => !hidden(e))
  } catch {
    throw new Error(`not a valid CSS selector: ${selector}`)
  }
  if (!items.length) throw new Error(`no visible element matches ${selector}`)
  return { key: `css:${selector}`, source: `${items.length} × ${selector}`, items, score: 0, text: "" }
}

/** Rows of the page's best (or chosen) table or repeated list; throws when the page has none. */
export function extract(doc: Document, opts: ExtractOpts = {}): ExtractResult {
  const max = Math.max(1, opts.max ?? 500)
  let chosen: Candidate | undefined
  let ranked: Candidate[] = []
  const selector = opts.selector ?? (opts.key?.startsWith("css:") ? opts.key.slice(4) : undefined)
  if (selector) chosen = fromSelector(doc, selector)
  else {
    ranked = candidates(doc)
    if (!ranked.length) throw new Error("no table or repeated list on this page")
    if (opts.near) {
      const want = fold(opts.near)
      // The tightest candidate holding the text: its items are the rows, not a section around them.
      const holding = ranked.filter((c) => c.text.includes(want))
      if (!holding.length) throw new Error(`no table or repeated list holds ${JSON.stringify(opts.near)}`)
      chosen = holding.sort((a, b) => b.score / Math.sqrt(b.text.length + 1) - a.score / Math.sqrt(a.text.length + 1))[0]
    } else if (opts.key) chosen = ranked.find((c) => c.key === opts.key) ?? ranked.find((c) => c.key.split(">")[1] === opts.key!.split(">")[1] && c.key.startsWith("list:"))
    if (!chosen && opts.key) throw new Error(`the table or list ${opts.key} is not on this page`)
    if (!chosen) {
      const i = opts.pick ?? 0
      chosen = ranked[i]
      if (!chosen) throw new Error(`pick ${i}: the page has ${ranked.length} candidate${ranked.length === 1 ? "" : "s"}`)
    }
  }
  const data = chosen.table ? tableExtract(doc, chosen.table, max) : listExtract(doc, chosen.items, max)
  const others = ranked
    .map((c, index) => ({ index, key: c.key, source: c.source, count: c.items.length }))
    .filter((c) => c.key !== chosen!.key)
    .slice(0, 5)
  return { key: chosen.key, source: chosen.source, ...data, others }
}
