import type { Method, NetworkEntry, ProbeResult } from "@kitestring/protocol"
import { KiteError } from "./rpc-client.js"
import { findRecordArrays, parseJsonText, scanEmbedded, type RecordArray } from "./scan.js"

export type Call = (method: Method, params: Record<string, unknown>) => Promise<unknown>

/** A network response whose JSON holds the page's records. */
export interface ProbeResponse {
  method: string
  url: string
  status?: number
  bodyId: number
  chars: number
  arrays: RecordArray[]
}

export interface Probe extends ProbeResult {
  embedded: { source: string; arrays: RecordArray[] }[]
  responses: ProbeResponse[]
  /** True when the tab was reloaded first, so its first load's responses were captured. */
  reloaded?: boolean
}

/**
 * Everything an agent needs to write a bulk extraction for the page in one go: its lists (page.probe), its embedded
 * state and the JSON responses it fetched, each searched for the list's visible values. `reload` loads the page again
 * first, so responses from its first load are kept too.
 */
export async function runProbe(call: Call, o: { reload?: boolean } = {}): Promise<Probe> {
  if (o.reload) {
    const tabs = (await call("tab.list", {})) as { tabs: { url: string; active?: boolean }[] }
    const url = tabs.tabs.find((t) => t.active)?.url
    if (!url) throw new KiteError("NO_TAB", "no active tab to reload")
    await call("act.batch", { steps: [{ action: "goto", url, wait_until: "idle" }], wait_idle: "never" })
  }
  // A list drawn after load (fetched, then rendered): wait for the page to go quiet, and look again if none is there yet.
  const quiet = async (ms: number) => {
    try {
      await call("page.wait", { cond: { idle: true }, timeout_ms: ms })
    } catch (e) {
      if (!(e instanceof KiteError && (e.code === "TIMEOUT" || e.code === "BAD_REQUEST"))) throw e
    }
  }
  await quiet(5_000)
  let page = (await call("page.probe", {})) as ProbeResult
  for (let i = 0; i < 3 && !page.lists.length; i++) {
    await new Promise((r) => setTimeout(r, 1_000))
    page = (await call("page.probe", {})) as ProbeResult
  }
  const needles = page.needles
  let embedded: Probe["embedded"] = []
  try {
    const expr = `(${scanEmbedded.toString()})(${JSON.stringify(needles)}, ${JSON.stringify(findRecordArrays.toString())})`
    embedded = (((await call("page.eval", { expression: expr })) as { value?: Probe["embedded"] }).value ?? []).filter((e) => e.arrays.length)
  } catch (e) {
    if (!(e instanceof KiteError && e.code === "BAD_REQUEST")) throw e
  }
  const responses: ProbeResponse[] = []
  const net = (await call("page.network", { bodies: true, body_max: 0, limit: 100 })) as { entries: NetworkEntry[] }
  for (const entry of net.entries.reverse()) {
    if (entry.bodyId === undefined || responses.length >= 5) continue
    let body: string
    try {
      body = ((await call("page.network", { body: entry.bodyId })) as { body: string }).body
    } catch {
      continue
    }
    const json = parseJsonText(body)
    if (json === undefined) continue
    const arrays = findRecordArrays(json, needles, 2)
    // With no needles (no list on screen) any records count; with them, only arrays that hold some.
    if (!arrays.length || (needles.length && !arrays[0]!.hits)) continue
    responses.push({ method: entry.method, url: entry.url, ...(entry.status !== undefined ? { status: entry.status } : {}), bodyId: entry.bodyId, chars: body.length, arrays })
  }
  responses.sort((a, b) => (b.arrays[0]?.hits ?? 0) - (a.arrays[0]?.hits ?? 0))
  return { ...page, embedded, responses, ...(o.reload ? { reloaded: true } : {}) }
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** What the agent reads: the lists, paging, where the data is, and the shortest way to read all of it. */
export function formatProbe(p: Probe): string {
  const L: string[] = [`page: ${cut(p.title, 80)} ${p.url}`]
  const n = p.needles.length
  if (!p.lists.length) L.push("lists: none (no table or repeated list on screen)")
  else {
    L.push("lists (best first):")
    for (const l of p.lists) {
      L.push(`  ${l.index}. ${l.source}${l.scrollAt ? "; scrolls in a panel of its own" : ""}`)
      if (l.selector) L.push(`     items: ${JSON.stringify(l.selector)}`)
      L.push(`     columns: ${l.columns.join(", ")}`)
      if (l.fields) L.push(`     fields: ${JSON.stringify(l.fields)}`)
      if (l.link) L.push(`     detail link column: ${l.link}`)
      for (const r of l.sample) L.push(`     row: ${cut(JSON.stringify(r), 300)}`)
      if (l.itemHtml && l.index === 0) L.push(`     item html: ${l.itemHtml}`)
    }
  }
  L.push(`more: ${p.more.next ? `next button ${JSON.stringify(p.more.next)}` : p.more.scroll ? `scroll the ${p.more.scroll}` : "none seen (one page)"}`)
  for (const e of p.embedded) for (const a of e.arrays.slice(0, 2)) L.push(`embedded data: ${e.source} ${a.path}: ${a.count} records {${a.keys.slice(0, 12).join(", ")}}${n ? `, holds ${a.hits}/${n} visible values in ${a.spread} records` : ""}; first: ${cut(a.sample, 240)}`)
  for (const r of p.responses) {
    const a = r.arrays[0]!
    L.push(`network JSON: ${r.method} ${cut(r.url, 160)} (${r.status ?? "?"}, ${Math.round(r.chars / 1024)} KB) at ${a.path}: ${a.count} records${n ? `, holds ${a.hits}/${n} visible values in ${a.spread} records` : ""}; first: ${cut(a.sample, 240)}`)
  }
  if (!p.responses.length && !p.reloaded) L.push("network JSON: none kept (pass reload to capture the page's first load)")
  L.push(`suggest: ${suggest(p)}`)
  return L.join("\n")
}

/** The cheapest way to read every record, from what the probe found. */
export function suggest(p: Probe): string {
  const n = p.needles.length
  const strong = (a: RecordArray) => n > 0 && a.hits >= Math.max(2, Math.ceil(n * 0.6)) && a.spread >= Math.max(2, Math.ceil(n * 0.5))
  const res = p.responses.find((r) => strong(r.arrays[0]!))
  if (res) return `the records come from ${res.method} ${cut(res.url, 120)}: read them with responses({filter}) after each scroll, or call it for every page with fetchJson (change its page/offset/cursor parameter); spec "api"`
  const emb = p.embedded.find((e) => strong(e.arrays[0]!))
  if (emb) return `the records are embedded in ${emb.source} at ${emb.arrays[0]!.path}: read them with evaluate, no scrolling`
  const top = p.lists[0]
  if (!top) return "no records on screen: open the page that lists them (a search, a category), then probe again"
  const more = p.more.next ? `more: ${JSON.stringify(p.more.next)}` : p.more.scroll ? `more: "scroll"` : ""
  const list = `collect({${top.selector ? `items: ${JSON.stringify(top.selector)}, ` : ""}${top.fields ? "fields, " : ""}${more}})`
  return top.link ? `${list} for the links, then readEach(links, fn) for each detail page; spec "list" + "detail"` : `${list}; spec "list"`
}
