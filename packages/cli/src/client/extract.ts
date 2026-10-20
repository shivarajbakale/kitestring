import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, extname, resolve } from "node:path"
import { parseTarget, type ActionResult, type ExtractCandidate, type ExtractResult, type Method } from "@kitestring/protocol"
import { KiteError } from "./rpc-client.js"

export type Call = (method: Method, params: Record<string, unknown>) => Promise<unknown>

export interface ExtractOpts {
  near?: string
  selector?: string
  key?: string
  pick?: number
  /** How to get to the next page: the visible text or @ref of its button or link, or "scroll" (infinite lists). */
  next?: string
  /** At most this many pages, the first included (1 without `next`). */
  pages?: number
  /** At most this many rows in all. */
  max?: number
  /** Stop paging once this much time has passed (an MCP call has a bound of its own). */
  budgetMs?: number
}

export interface Extracted {
  key: string
  source: string
  columns: string[]
  rows: Record<string, string>[]
  pages: number
  /** Why paging stopped, when it did before `pages` (no next button, no new rows, the row limit, time). */
  stopped?: string
  others: ExtractCandidate[]
}

export const DEFAULT_MAX_ROWS = 500
export const MAX_ROWS = 5_000
export const MAX_PAGES = 50
/** After a click on next, the new rows are read again for this long before paging gives up (pages that render late). */
const NEW_ROWS_WAIT_MS = 4_000
const NEW_ROWS_POLL_MS = 1_000

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const rowKey = (r: Record<string, string>) => JSON.stringify(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))

/**
 * Reads the page's table or repeated list, then (with `next`) clicks next or scrolls and reads it again, up to `pages`.
 * Rows seen on an earlier page are not repeated (infinite lists keep the old ones). Columns are the union, in order.
 */
export async function extractPages(call: Call, o: ExtractOpts, sleep: (ms: number) => Promise<void> = sleepMs): Promise<Extracted> {
  const started = Date.now()
  const max = Math.min(MAX_ROWS, o.max ?? DEFAULT_MAX_ROWS)
  const pages = o.next ? Math.min(MAX_PAGES, o.pages ?? 5) : 1
  const pick = (r: Partial<ExtractOpts>) => ({
    ...(r.near !== undefined ? { near: r.near } : {}),
    ...(r.selector !== undefined ? { selector: r.selector } : {}),
    ...(r.key !== undefined ? { key: r.key } : {}),
    ...(r.pick !== undefined ? { pick: r.pick } : {}),
    max: MAX_ROWS,
  })
  const first = (await call("page.extract", pick(o))) as ExtractResult
  const columns = [...first.columns]
  const seen = new Set<string>()
  const rows: Record<string, string>[] = []
  const add = (r: ExtractResult): number => {
    for (const c of r.columns) if (!columns.includes(c)) columns.push(c)
    let n = 0
    for (const row of r.rows) {
      const k = rowKey(row)
      if (seen.has(k) || rows.length >= max) continue
      seen.add(k)
      rows.push(row)
      n++
    }
    return n
  }
  add(first)
  // Later pages find the same table or list by its key (a selector stays a selector).
  const again = o.selector !== undefined ? { selector: o.selector } : { key: first.key }
  let page = 1
  let stopped: string | undefined
  while (page < pages) {
    if (rows.length >= max) {
      stopped = `reached ${max} rows`
      break
    }
    if (o.budgetMs !== undefined && Date.now() - started > o.budgetMs) {
      stopped = `out of time after ${page} page${page === 1 ? "" : "s"}`
      break
    }
    try {
      const r = (o.next === "scroll" ? await call("act.scroll", { direction: "down", px: 2_000 }) : await call("act.click", { target: parseTarget(o.next!) })) as ActionResult | null
      if (r && r.ok === false) {
        stopped = `no next page (${r.status}${r.detail ? `: ${r.detail.split("\n")[0]}` : ""})`
        break
      }
    } catch (e) {
      if (e instanceof KiteError && (e.code === "BAD_REQUEST" || e.code === "TIMEOUT")) {
        stopped = `no next page (${e.message.split("\n")[0]})`
        break
      }
      throw e
    }
    let added = 0
    for (let waited = 0; ; waited += NEW_ROWS_POLL_MS) {
      try {
        added = add((await call("page.extract", pick(again))) as ExtractResult)
      } catch (e) {
        if (!(e instanceof KiteError && e.code === "BAD_REQUEST")) throw e
      }
      if (added || waited >= NEW_ROWS_WAIT_MS) break
      await sleep(NEW_ROWS_POLL_MS)
    }
    page++
    if (!added) {
      stopped = `page ${page} brought no new rows`
      break
    }
  }
  if (!stopped && rows.length >= max && first.total > max) stopped = `reached ${max} rows`
  return { key: first.key, source: first.source, columns, rows, pages: page, ...(stopped ? { stopped } : {}), others: first.others }
}

/** RFC 4180 CSV: a header line, then one line per row ("" for a column the row lacks). */
export function toCsv(columns: string[], rows: Record<string, string>[]): string {
  // A cell starting with = + - @ is a formula to spreadsheets: a leading ' keeps it text.
  const cell = (v: string) => {
    const t = /^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  return [columns, ...rows.map((r) => columns.map((c) => r[c] ?? ""))].map((l) => l.map(cell).join(",")).join("\n") + "\n"
}

export type SaveFormat = "csv" | "json" | "jsonl"

export function formatOf(file: string): SaveFormat {
  const ext = extname(file).toLowerCase()
  if (ext === ".csv") return "csv"
  if (ext === ".json") return "json"
  if (ext === ".jsonl" || ext === ".ndjson") return "jsonl"
  throw new KiteError("BAD_REQUEST", `save to a .csv, .json or .jsonl file: ${file}`)
}

export function serialize(x: Pick<Extracted, "columns" | "rows">, format: SaveFormat): string {
  if (format === "csv") return toCsv(x.columns, x.rows)
  if (format === "json") return JSON.stringify(x.rows, null, 2) + "\n"
  return x.rows.map((r) => JSON.stringify(r)).join("\n") + (x.rows.length ? "\n" : "")
}

/** Writes the rows to `file` (format from its extension, relative to `cwd`); the absolute path. */
export function saveRows(x: Pick<Extracted, "columns" | "rows">, file: string, cwd: string): string {
  const path = resolve(cwd, file)
  const text = serialize(x, formatOf(path))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** One line on what was read: `24 rows × 5 columns from list of 24 div.card (2 pages; page 3 brought no new rows)`. */
export function extractSummary(x: Extracted): string {
  const paging = x.pages > 1 || x.stopped ? ` (${x.pages} page${x.pages === 1 ? "" : "s"}${x.stopped ? `; ${x.stopped}` : ""})` : ""
  return `${x.rows.length} row${x.rows.length === 1 ? "" : "s"} × ${x.columns.length} columns from ${x.source}${paging}`
}
