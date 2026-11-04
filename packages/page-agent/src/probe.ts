/**
 * What a page's data looks like, for an agent about to write a bulk extraction: the repeated lists on it (with a CSS
 * selector for their items and one per field, ready for `collect`), how the page shows more of them (a next button, or
 * scrolling the page or a panel), and the visible values an embedded-JSON or network scan can look for.
 */

import type { ProbeList, ProbeResult } from "@kitestring/protocol"
import { candidates, hidden, innerScrollPoint, listExtract, meaningfulClasses, signature, tableExtract, type Candidate } from "./extract.js"

export type { ProbeList, ProbeResult } from "@kitestring/protocol"

const MAX_LISTS = 3
const SAMPLE_ROWS = 2
const ITEM_HTML_MAX = 1_500
const NEEDLES_MAX = 12

const cssIdent = (s: string): string => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`))

/** Tag plus the classes `signature` uses, as CSS. */
function sigCss(el: Element): string {
  return el.tagName.toLowerCase() + meaningfulClasses(el).sort().slice(0, 2).map((c) => `.${cssIdent(c)}`).join("")
}

const count = (doc: Document, sel: string): number => {
  try {
    return doc.querySelectorAll(sel).length
  } catch {
    return -1
  }
}

/** A selector that names `el` alone on the page, when a short one exists: an id, a labelled role, or a short path. */
function uniqueCss(doc: Document, el: Element): string | undefined {
  if (el.id && /^[A-Za-z][\w-]{0,60}$/.test(el.id) && count(doc, `#${cssIdent(el.id)}`) === 1) return `#${cssIdent(el.id)}`
  const role = el.getAttribute("role")
  const label = el.getAttribute("aria-label")
  if (role && label && label.length <= 60) {
    const s = `[role="${role}"][aria-label="${label.replace(/"/g, '\\"')}"]`
    if (count(doc, s) === 1) return s
  }
  if (role) {
    const s = `[role="${role}"]`
    if (count(doc, s) === 1) return s
  }
  const own = sigCss(el)
  if (own.includes(".") && count(doc, own) === 1) return own
  const up = el.parentElement
  if (!up || up === doc.body || up === doc.documentElement) return undefined
  const above = uniqueCss(doc, up)
  if (!above) return undefined
  const s = `${above} > ${own}`
  return count(doc, s) === 1 ? s : undefined
}

/** A CSS selector that matches exactly the candidate's items (or, failing that, every one of them and few others). */
function itemSelector(doc: Document, c: Candidate): string | undefined {
  const first = c.items[0]
  const parent = first?.parentElement
  if (!first || !parent) return undefined
  const sig = sigCss(first)
  const tries: string[] = []
  const p = uniqueCss(doc, parent)
  if (p) tries.push(`${p} > ${sig}`)
  if (sig.includes(".")) tries.push(sig)
  for (const s of tries) {
    let found: Element[]
    try {
      found = Array.from(doc.querySelectorAll(s)).filter((e) => !hidden(e))
    } catch {
      continue
    }
    if (c.items.every((it) => found.includes(it)) && found.length <= c.items.length * 1.2 + 1) return s
  }
  return undefined
}

/** The element a part path (`/div.title/span[1]`) names inside `item`. */
function resolvePath(item: Element, path: string): Element | null {
  let el: Element | null = item
  for (const seg of path.split("/").filter(Boolean)) {
    const m = /^(.*?)(?:\[(\d+)\])?$/.exec(seg)!
    const want = m[1]!
    const idx = Number(m[2] ?? 0)
    let n = 0
    let next: Element | null = null
    for (const c of Array.from(el!.children)) {
      if (signature(c) !== want) continue
      if (n++ === idx) {
        next = c
        break
      }
    }
    if (!next) return null
    el = next
  }
  return el
}

/** `:scope > div.title > span:nth-of-type(2)` for the element at `path` inside `item`. */
function relativeCss(item: Element, path: string): string | undefined {
  const target = resolvePath(item, path)
  if (!target) return undefined
  if (target === item) return ""
  const chain: string[] = []
  for (let el: Element | null = target; el && el !== item; el = el.parentElement) {
    let s = sigCss(el)
    const same = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.tagName === el!.tagName) : []
    const all = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.matches(s)) : []
    if (all.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`
    chain.unshift(s)
  }
  const sel = `:scope > ${chain.join(" > ")}`
  try {
    return item.querySelector(sel) === target ? sel : undefined
  } catch {
    return undefined
  }
}

/** One field per column: `css` (its text) or `css@attr`, relative to an item; empty css is the item itself. */
function fieldSelectors(items: Element[], paths: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const first = items[0]
  if (!first) return out
  for (const [name, full] of Object.entries(paths)) {
    const at = full.lastIndexOf("@")
    const path = at >= 0 ? full.slice(0, at) : full
    const attr = at >= 0 ? full.slice(at + 1) : ""
    // The first item that has the part: a column can be missing from the first row.
    for (const it of items.slice(0, 5)) {
      const css = relativeCss(it, path)
      if (css === undefined) continue
      out[name] = attr ? `${css}@${attr}` : css || "."
      break
    }
  }
  return out
}

const KEEP_ATTRS = /^(id|class|href|src|alt|title|role|aria-label|itemprop|itemtype|datetime|data-[\w-]+)$/i

/** The item's markup, cut down to what helps write selectors: no scripts, styles or svg, short text, few attributes. */
function itemHtml(item: Element): string {
  const clone = item.cloneNode(true) as Element
  for (const el of Array.from(clone.querySelectorAll("script,style,svg,noscript,template,iframe,canvas"))) el.remove()
  const walk = (el: Element): void => {
    for (const a of Array.from(el.attributes)) {
      if (!KEEP_ATTRS.test(a.name) || a.value.length > 120) el.removeAttribute(a.name)
    }
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) {
        const t = (n.textContent ?? "").replace(/\s+/g, " ")
        n.textContent = t.length > 60 ? `${t.slice(0, 59)}…` : t
      } else if (n.nodeType === 8) n.remove()
      else if (n.nodeType === 1) walk(n as Element)
    }
  }
  walk(clone)
  const html = clone.outerHTML.replace(/>\s+</g, "><")
  return html.length > ITEM_HTML_MAX ? `${html.slice(0, ITEM_HTML_MAX - 1)}…` : html
}

const NEXT_TEXT = /^(next|next page|more|more results|load more|show more|see more|view more|older|›|»|→|>|next ›|next »|next →)$/i

/** The visible text of a button or link that goes to the next page, if the page has one. */
function nextControl(doc: Document): string | undefined {
  const els = Array.from(doc.querySelectorAll('a[rel~="next"],link[rel~="next"],a,button,[role="button"],[role="link"]'))
  for (const el of els) {
    if (el.tagName === "LINK" || hidden(el)) continue
    const text = (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim() ?? ""
    const label = el.getAttribute("aria-label")?.trim() ?? ""
    if (el.getAttribute("rel")?.split(/\s+/).includes("next")) return text || label || undefined
    if (NEXT_TEXT.test(text)) return text
    if (!text && /^next( page)?$/i.test(label)) return label
  }
  return undefined
}

/** Cell values worth searching embedded JSON and network responses for: names and titles, not numbers or URLs. */
function needlesOf(rows: Record<string, string>[]): string[] {
  const out: string[] = []
  for (const r of rows.slice(0, 6)) {
    for (const [k, v] of Object.entries(r)) {
      if (k === "link" || k === "image" || out.length >= NEEDLES_MAX) continue
      if (v.length < 4 || v.length > 80 || !/\p{L}{3}/u.test(v) || /^https?:/.test(v) || out.includes(v)) continue
      out.push(v)
      break
    }
  }
  return out
}

function listInfo(doc: Document, c: Candidate, index: number): ProbeList {
  const data = c.table ? { ...tableExtract(doc, c.table, SAMPLE_ROWS), paths: {} as Record<string, string> } : listExtract(doc, c.items, 50)
  const selector = c.table ? undefined : itemSelector(doc, c)
  // A column of separators ("·", "|") is markup, not data: no field for it.
  const paths = Object.fromEntries(Object.entries(data.paths).filter(([col]) => data.rows.some((r) => /[\p{L}\p{N}]/u.test(r[col] ?? ""))))
  const fields = c.table ? {} : fieldSelectors(c.items, paths)
  const at = innerScrollPoint(doc, c.table ?? c.items[0]!)
  const linkCol = data.columns.find((col) => col === "link" || col.startsWith("link "))
  return {
    index,
    key: c.key,
    source: c.source,
    count: c.items.length,
    ...(selector ? { selector } : {}),
    columns: data.columns,
    ...(Object.keys(fields).length ? { fields } : {}),
    sample: data.rows.slice(0, SAMPLE_ROWS),
    ...(linkCol ? { link: linkCol } : {}),
    ...(c.items[0] && !c.table ? { itemHtml: itemHtml(c.items[0]) } : {}),
    ...(at ? { scrollAt: at } : {}),
  }
}

/** The page's lists, paging and search needles (see the file comment). */
export function probe(doc: Document): ProbeResult {
  const ranked = candidates(doc)
  const lists = ranked.slice(0, MAX_LISTS).map((c, i) => listInfo(doc, c, i))
  const win = doc.defaultView
  const tall = !!win && (doc.scrollingElement?.scrollHeight ?? 0) > win.innerHeight * 1.5
  const next = nextControl(doc)
  const top = lists[0]
  const more: ProbeResult["more"] = next ? { next } : top?.scrollAt ? { scroll: "panel" } : tall ? { scroll: "page" } : {}
  const best = ranked[0]
  const rows = best ? (best.table ? tableExtract(doc, best.table, 6).rows : listExtract(doc, best.items, 6).rows) : []
  return {
    url: doc.location?.href ?? "",
    title: doc.title,
    lists,
    more,
    needles: needlesOf(rows),
  }
}
