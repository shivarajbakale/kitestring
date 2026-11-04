import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Method } from "@kitestring/protocol"
import { RowSet, collectList, fieldsReader, readEach } from "../src/client/collect.js"
import { KiteError } from "../src/client/rpc-client.js"
import { atPath, findRecordArrays, parseJsonText } from "../src/client/scan.js"
import { suggest, type Probe } from "../src/client/probe.js"
import { runJob } from "../src/job/run.js"
import { compileSpec, parseSpec, specId, specNeedsInput } from "../src/job/spec.js"
import { jobWork } from "../src/job/start.js"
import { createJob, listJobs, listRecipes, loadRecipe, readRows, readStatus, saveRecipe } from "../src/job/store.js"
import { runScript } from "../src/script/run.js"

let home: string
beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "kite-bulk-"))))
afterEach(() => rmSync(home, { recursive: true, force: true }))

type Answer = (method: Method, params: Record<string, unknown>, session?: string) => unknown
const urlIn = (expr: string) => /"(https?:\/\/[^"]+)"/.exec(expr)?.[1] ?? ""

/** The JSON a fetchJson in the page answers with, for the page number in its URL. */
const apiPage = (expr: string, pages: unknown[][]) => {
  const n = Number(/page=(\d+)/.exec(expr)?.[1] ?? 1)
  return { value: { status: 200, text: `)]}'\n${JSON.stringify({ data: { items: pages[n - 1] ?? [] } })}` } }
}

describe("finding records in JSON", () => {
  const json = {
    meta: { query: "warehouses", tags: ["a", "b"] },
    data: { items: [1, 2, 3].map((n) => ({ id: n, name: `Warehouse ${n}`, tags: [{ t: "x" }, { t: "y" }] })) },
    other: [{ x: 1 }, { x: 2 }],
  }

  it("ranks the array holding the visible values first, and leaves out arrays inside it", () => {
    const found = findRecordArrays(json, ["Warehouse 1", "warehouse 2", "Nowhere"])
    expect(found[0]).toMatchObject({ path: "data.items", count: 3, keys: ["id", "name", "tags"], hits: 2 })
    expect(found.some((a) => a.path.startsWith("data.items["))).toBe(false)
    expect(found.some((a) => a.path === "other")).toBe(false)
  })

  it("passes over a state blob that holds the values in one place, not spread over records", () => {
    const blob = [[1, 2], ["x"], { all: "Warehouse 1 Warehouse 2 Warehouse 3" }]
    expect(findRecordArrays(blob, ["Warehouse 1", "Warehouse 2", "Warehouse 3"])).toEqual([])
  })

  it("reads arrays of arrays (APIs with no keys) and gives their path from the root", () => {
    const v = [["meta"], [["Warehouse 1", 12], ["Warehouse 2", 13]]]
    expect(findRecordArrays(v, ["Warehouse 2"])[0]).toMatchObject({ path: "[1]", count: 2, keys: ["0", "1"], hits: 1, spread: 1 })
    expect(atPath(v, "[1][0][1]")).toBe(12)
    expect(atPath(json, "data.items[2].name")).toBe("Warehouse 3")
    expect(atPath(json, "(root)")).toBe(json)
    expect(atPath(json, "data.missing.x")).toBeUndefined()
  })

  it("parses JSON behind an anti-hijacking prefix, and one value per line", () => {
    expect(parseJsonText(`)]}'\n{"a":1}`)).toEqual({ a: 1 })
    expect(parseJsonText(`for(;;);[1]`)).toEqual([1])
    expect(parseJsonText(`{"a":1}\n{"a":2}\n`)).toEqual([{ a: 1 }, { a: 2 }])
    expect(parseJsonText("<html>")).toBeUndefined()
  })

  it("suggests the network JSON when it holds most visible values, else the list with its link", () => {
    const base: Probe = { url: "", title: "", lists: [{ index: 0, key: "k", source: "list", count: 3, selector: "#p > div.c", columns: ["name", "link"], sample: [], link: "link" }], more: { scroll: "panel" }, needles: ["a", "b", "c"], embedded: [], responses: [] }
    expect(suggest(base)).toBe('collect({items: "#p > div.c", more: "scroll"}) for the links, then readEach(links, fn) for each detail page; spec "list" + "detail"')
    const arrays = [{ path: "results", count: 3, keys: [], hits: 3, spread: 3, sample: "" }]
    expect(suggest({ ...base, responses: [{ method: "GET", url: "https://s/api?page=1", bodyId: 1, chars: 10, arrays }] })).toMatch(/^the records come from GET https:\/\/s\/api\?page=1/)
    expect(suggest({ ...base, embedded: [{ source: "script#__NEXT_DATA__", arrays }] })).toMatch(/^the records are embedded in script#__NEXT_DATA__ at results/)
  })
})

describe("collect", () => {
  it("reads fields, scrolls the list's own panel until two scrolls bring nothing, and keeps each row once by id", async () => {
    const pages = [[{ name: "A", link: "u1" }, { name: "B", link: "u2" }], [{ name: "B", link: "u2" }, { name: "C", link: "u3" }], [{ name: "C", link: "u3" }]]
    let shown = 0
    const sent: { method: string; params: Record<string, unknown> }[] = []
    const call = async (method: Method, params: Record<string, unknown>) => {
      sent.push({ method, params })
      if (method === "act.scroll") shown = Math.min(pages.length - 1, shown + 1)
      if (method === "page.eval") return { value: JSON.stringify({ rows: pages[shown], total: 2, scrollAt: { x: 10, y: 20 } }) }
      return { ok: true, status: "done" }
    }
    const got: string[] = []
    const r = await collectList(call, { items: ".c", fields: { name: "h3", link: "a@href" }, more: "scroll", id: "link", waitMs: 0 }, { onRows: (rows) => got.push(...rows.map((x) => x.name as string)), sleep: async () => {} })
    expect(r.rows.map((x) => x.name)).toEqual(["A", "B", "C"])
    expect(got).toEqual(["A", "B", "C"])
    expect(r.stopped).toBe("no new rows after scrolling")
    expect(sent.find((s) => s.method === "act.scroll")!.params).toEqual({ direction: "down", px: 2_500, at: { x: 10, y: 20 } })
    expect(String(sent[0]!.params.expression)).toMatch(/^JSON\.stringify\(\(function readListInPage/)
  })

  it("stops after one scroll that brings nothing when the list is already at its bottom", async () => {
    let scrolls = 0
    const call = async (method: Method) => {
      if (method === "act.scroll") scrolls++
      if (method === "page.eval") return { value: JSON.stringify({ rows: [{ a: "1" }], total: 1, atEnd: true }) }
      return { ok: true }
    }
    const r = await collectList(call, { items: ".c", fields: { a: "b" }, more: "scroll", waitMs: 0 }, { sleep: async () => {} })
    expect(scrolls).toBe(1)
    expect(r.stopped).toBe("no new rows after scrolling")
  })

  it("stops at the limit, and at a next button that is gone", async () => {
    let page = 0
    const call = async (method: Method) => {
      if (method === "page.extract") return { key: "list:x", rows: [{ n: `r${page}a` }, { n: `r${page}b` }], columns: ["n"], total: 2, others: [], source: "" }
      if (method === "act.click") return page++ < 1 ? { ok: true, status: "done" } : { ok: false, status: "not_found", detail: 'no "Next"' }
      return null
    }
    expect((await collectList(call, { more: "Next", limit: 3, waitMs: 0 }, { sleep: async () => {} })).rows).toHaveLength(3)
    page = 0
    const r = await collectList(call, { more: "Next", waitMs: 0 }, { sleep: async () => {} })
    expect(r.rows.map((x) => x.n)).toEqual(["r0a", "r0b", "r1a", "r1b"])
    expect(r.stopped).toBe('no next page (not_found: no "Next")')
  })

  it("refuses fields without the items they are read from", async () => {
    await expect(collectList(async () => null, { fields: { a: "b" } })).rejects.toThrow("fields need items")
  })
})

describe("readEach", () => {
  it("reads each URL in worker tabs (one session each), joins nothing for plain URLs, and closes the tabs", async () => {
    const sessions = new Set<string>()
    const log: string[] = []
    const worker = (n: number) => async (method: Method, params: Record<string, unknown>) => {
      sessions.add(`w${n}`)
      log.push(`${n}:${method}`)
      if (method === "page.eval") return { value: JSON.stringify({ phone: `p-${urlIn(String(params.expression)).slice(-1)}` }) }
      if (method === "act.batch") return { ok: true }
      return null
    }
    const urls = ["https://s/1", "https://s/2", "https://s/3", "https://s/4", "https://s/5"]
    const rows = await readEach(urls, "(doc) => ({})", { concurrency: 2, delayMs: 0, wait: "h1" }, { worker, main: async () => null })
    expect(rows).toEqual(urls.map((u) => ({ url: u, phone: `p-${u.slice(-1)}` })))
    expect([...sessions].sort()).toEqual(["w1", "w2"])
    expect(log.filter((l) => l.endsWith("tab.new"))).toHaveLength(2)
    expect(log.filter((l) => l.endsWith("tab.close"))).toHaveLength(2)
    expect(log.filter((l) => l.endsWith("page.wait"))).toHaveLength(5)
  })

  it("keeps a failed page as {url, error}, and stops when the first five all fail", async () => {
    const worker = () => async (method: Method, params: Record<string, unknown>) => {
      if (method !== "page.eval") return { ok: true }
      if (urlIn(String(params.expression)).endsWith("/2")) throw new KiteError("BAD_REQUEST", "page script threw: boom")
      return { value: JSON.stringify({ ok: 1 }) }
    }
    const rows = await readEach(["https://s/1", "https://s/2"], "f", { concurrency: 1, delayMs: 0 }, { worker, main: async () => null })
    expect(rows).toEqual([{ url: "https://s/1", ok: 1 }, { url: "https://s/2", error: "page script threw: boom" }])
    const bad = () => async (method: Method) => {
      if (method === "page.eval") throw new KiteError("BAD_REQUEST", "nope")
      return { ok: true }
    }
    const many = Array.from({ length: 9 }, (_, i) => `https://s/${i}`)
    await expect(readEach(many, "f", { concurrency: 1, delayMs: 0 }, { worker: bad, main: async () => null })).rejects.toThrow("the first 5 pages all failed")
  })

  it("fetch mode reads through the main tab, parsing the HTML; non-http URLs are refused", async () => {
    const exprs: string[] = []
    const main = async (_m: Method, p: Record<string, unknown>) => {
      exprs.push(String(p.expression))
      return { value: JSON.stringify({ title: "T" }) }
    }
    const rows = await readEach(["https://s/a"], fieldsReader({ title: "h1" }), { mode: "fetch" }, { worker: () => main, main })
    expect(rows).toEqual([{ url: "https://s/a", title: "T" }])
    expect(exprs[0]).toContain("new DOMParser().parseFromString")
    await expect(readEach(["javascript:alert(1)"], "f", {}, { worker: () => main, main })).rejects.toThrow("every url must be an http(s) URL")
  })
})

describe("scripts that emit", () => {
  const opts = (answer: Answer, extra: object = {}) => ({
    call: async (m: Method, p: Record<string, unknown>) => answer(m, p),
    worker: (n: number) => async (m: Method, p: Record<string, unknown>) => answer(m, p, `w${n}`),
    timeoutMs: 20_000,
    resolveFiles: (f: string[]) => f,
    ...extra,
  })

  it("keeps emitted rows once by id, gives the script params and resume, and checkpoints", async () => {
    const states: unknown[] = []
    const r = await runScript(
      `await emit([{ id: 1, n: params.who }, { id: 2 }])
       const again = await emit({ id: 1, n: "dup" })
       await checkpoint({ at: 2, before: resume })
       return again`,
      opts(() => null, { params: { who: "ada" }, resume: { at: 1 }, sink: { seen: new RowSet("id"), checkpoint: (s: unknown) => states.push(s) } }),
    )
    expect(r.error).toBeUndefined()
    expect(r.emitted).toEqual([{ id: 1, n: "ada" }, { id: 2 }])
    expect(JSON.parse(r.value!)).toEqual({ added: 0, total: 2 })
    expect(states).toEqual([{ at: 2, before: { at: 1 } }])
  })

  it("readEach on rows joins each page's fields to its row and emits them", async () => {
    const r = await runScript(
      `const cards = [{ name: "A", link: "https://s/a" }, { name: "B", link: "https://s/b" }]
       const out = await readEach(cards, (doc) => ({ phone: "1" }), { emit: true, delayMs: 0 })
       return out.length`,
      opts((m, p) => (m === "page.eval" ? { value: JSON.stringify({ url: urlIn(String(p.expression)), phone: urlIn(String(p.expression)).slice(-1) }) } : { ok: true }), { sink: { seen: new RowSet("link") } }),
    )
    expect(r.error).toBeUndefined()
    expect(r.value).toBe("2")
    expect(r.emitted).toEqual([
      { name: "A", link: "https://s/a", phone: "a" },
      { name: "B", link: "https://s/b", phone: "b" },
    ])
    expect(r.logs).toContain("readEach: 2 read")
  })

  it("fetchJson strips the anti-hijacking prefix, and an HTTP error throws its status", async () => {
    const r = await runScript(
      `const v = await fetchJson("https://s/api?page=1")
       try { await fetchJson("https://s/missing") } catch (e) { return [v, e.code, e.status] }`,
      opts((m, p) => (String(p.expression).includes("missing") ? { value: { status: 404, text: "" } } : apiPage(String(p.expression), [[{ a: 1 }]]))),
    )
    expect(JSON.parse(r.value!)).toEqual([{ data: { items: [{ a: 1 }] } }, "HTTP_404", 404])
  })
})

describe("specs", () => {
  it("checks a spec and names the field at fault", () => {
    expect(() => parseSpec({ detail: { fields: "auto" } })).toThrow("spec: a spec needs list or api")
    expect(() => parseSpec({ list: {}, api: { url: "u" } })).toThrow("a spec reads a list or an api, not both")
    expect(() => parseSpec({ list: { more: 3 } })).toThrow("spec.list.more: Expected string")
    expect(() => parseSpec({ list: {}, colour: 1 })).toThrow("Unrecognized key(s) in object: 'colour'")
    expect(() => parseSpec("{")).toThrow("spec is not JSON")
    const s = parseSpec({ list: { more: "scroll" }, detail: { fields: "auto" } })
    expect(specId(s)).toBe("link")
    expect(specNeedsInput(s)).toBe(true)
    expect(specNeedsInput(parseSpec({ api: { url: "https://s/api?p={page}" } }))).toBe(false)
  })

  it("an api spec pages the endpoint until a page is empty, keeping the fields asked for", async () => {
    const pages = [[{ id: 1, name: "A", x: { y: 1 } }, { id: 2, name: "B" }], [{ id: 3, name: "C" }], []]
    const urls: string[] = []
    const r = await runScript(compileSpec(parseSpec({ api: { url: "https://s/api?page={page}&q={q}", rows: "data.items", fields: { id: "id", name: "name", y: "x.y" } }, params: { q: "a b" } })), {
      call: async (m: Method, p: Record<string, unknown>) => {
        if (m === "page.eval") {
          urls.push(urlIn(String(p.expression)))
          return apiPage(String(p.expression), pages)
        }
        return { tabs: [] }
      },
      timeoutMs: 20_000,
      resolveFiles: (f: string[]) => f,
      sink: { seen: new RowSet("id") },
    })
    expect(r.error).toBeUndefined()
    expect(r.emitted).toEqual([
      { id: "1", name: "A", y: "1" },
      { id: "2", name: "B", y: "" },
      { id: "3", name: "C", y: "" },
    ])
    expect(urls).toEqual(["https://s/api?page=1&q=a b", "https://s/api?page=2&q=a b", "https://s/api?page=3&q=a b"])
    expect(r.value).toBe("rows: 3")
  })

  it("inputs run once each, add their values to the rows, and a resumed run skips the sets it finished", async () => {
    const spec = parseSpec({ start: "https://s/search?q={q}", inputs: [{ q: "pune" }, { q: "goa" }], api: { url: "https://s/api?q={q}", rows: "items" } })
    const gotos: string[] = []
    const call = async (m: Method, p: Record<string, unknown>) => {
      if (m === "act.batch") {
        gotos.push(String((p.steps as { url: string }[])[0]!.url))
        return { ok: true, steps: [{ status: "done" }] }
      }
      if (m === "tab.list") return { tabs: [] }
      if (m === "page.eval") return { value: { status: 200, text: JSON.stringify({ items: [{ city: urlIn(String(p.expression)).split("=")[1] }] }) } }
      return null
    }
    const states: unknown[] = []
    const r = await runScript(compileSpec(spec), { call, timeoutMs: 20_000, resolveFiles: (f) => f, sink: { seen: new RowSet(), checkpoint: (s) => states.push(s) } })
    expect(r.error).toBeUndefined()
    expect(r.emitted).toEqual([{ q: "pune", city: "pune" }, { q: "goa", city: "goa" }])
    expect(gotos).toEqual(["https://s/search?q=pune", "https://s/search?q=goa"])
    expect(states).toEqual([{ done: [0] }, { done: [0, 1] }])
    gotos.length = 0
    const again = await runScript(compileSpec(spec), { call, timeoutMs: 20_000, resolveFiles: (f) => f, resume: { done: [0] }, sink: { seen: new RowSet() } })
    expect(again.emitted).toEqual([{ q: "goa", city: "goa" }])
    expect(gotos).toEqual(["https://s/search?q=goa"])
  })

  it("a job's work: code starts on the current page in front, an api spec in the background, a recipe with its params", () => {
    expect(jobWork(home, { code: "return 1" }, "https://s/x").work).toMatchObject({ kind: "script", startUrl: "https://s/x", window: "front" })
    expect(jobWork(home, { spec: { start: "https://s/q?term={q}", params: { q: "a&b" }, api: { url: "https://s/api" } } }).work).toMatchObject({ kind: "spec", startUrl: "https://s/q?term=a%26b", window: "background" })
    expect(() => jobWork(home, { code: "x", recipe: "y" })).toThrow("pass exactly one of code, spec or recipe")
    expect(() => jobWork(home, { recipe: "nope" })).toThrow("no such recipe: nope")
    saveRecipe(home, "Pune Dentists", jobWork(home, { spec: { start: "https://s/q?term={q}", params: { q: "dentists" }, list: { more: "scroll" }, detail: { fields: "auto" } } }).work)
    expect(listRecipes(home).map((r) => r.name)).toEqual(["pune-dentists"])
    const w = jobWork(home, { recipe: "pune-dentists", params: { q: "vets" } })
    expect(w.recipe).toBe("pune-dentists")
    expect(w.work).toMatchObject({ startUrl: "https://s/q?term=vets", window: "front", rowId: "link", params: { q: "vets" } })
    expect(loadRecipe(home, "pune-dentists").format).toBe("csv")
  })
})

describe("jobs", () => {
  const fakeBrowser = (onEval: (expr: string) => unknown) => {
    const sent: { method: string; session: string; params: Record<string, unknown> }[] = []
    const call = async (method: Method, params: Record<string, unknown>, session: string) => {
      sent.push({ method, session, params })
      if (method === "tab.new") return { id: 7, url: params.url }
      if (method === "tab.list") return { tabs: [] }
      if (method === "page.eval") return onEval(String(params.expression))
      if (method === "act.batch") return { ok: true, steps: [{ status: "done" }] }
      return null
    }
    return { sent, call }
  }

  it("runs in its own session and tab, streams rows to rows.jsonl, saves them, and closes the tab", async () => {
    const b = fakeBrowser((e) => apiPage(e, [[{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]]))
    const save = join(home, "out.csv")
    const def = createJob(home, { ...jobWork(home, { spec: { start: "https://s/", api: { url: "https://s/api?page={page}", rows: "data.items", pages: 5 }, id: "id" } }).work, save })
    const st = await runJob(home, def.id, b.call)
    expect(st, st.error).toMatchObject({ state: "done", rows: 3, runs: 1, savedTo: save, summary: "rows: 3" })
    expect(readRows(home, def.id)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(readFileSync(save, "utf8")).toBe("id\n1\n2\n3\n")
    expect(b.sent[0]).toMatchObject({ method: "tab.new", session: `job-${def.id}`, params: { url: "https://s/", background: true } })
    expect(b.sent.some((s) => s.method === "tab.close" && s.params.id === 7)).toBe(true)
    expect(b.sent.at(-1)).toMatchObject({ method: "notify", params: { title: `✓ ${def.id}: 3 rows` } })
    expect(listJobs(home)[0]!.status?.state).toBe("done")
  })

  it("a second run resumes: rows already kept are not added again, and the script gets its checkpoint", async () => {
    const b = fakeBrowser(() => ({ value: null }))
    const code = `await emit([{ k: "a" }, { k: "b" }]); await checkpoint({ n: (resume?.n ?? 0) + 1 }); return String(resume?.n ?? "none")`
    const def = createJob(home, { ...jobWork(home, { code, id: "k" }, "https://s/").work })
    expect((await runJob(home, def.id, b.call)).summary).toBe("none")
    const st = await runJob(home, def.id, b.call)
    expect(st).toMatchObject({ state: "done", rows: 2, runs: 2, summary: "1" })
    expect(readRows(home, def.id)).toEqual([{ k: "a" }, { k: "b" }])
  })

  it("a stopped job keeps the rows it had; a failed one says why and leaves its window open", async () => {
    const b = fakeBrowser(() => ({ value: null }))
    const ac = new AbortController()
    const def = createJob(home, jobWork(home, { code: `await emit({ k: 1 }); await sleep(5000)` }, "https://s/").work)
    const running = runJob(home, def.id, b.call, { signal: ac.signal })
    await new Promise((r) => setTimeout(r, 400))
    expect(readStatus(home, def.id)?.state).toBe("running")
    ac.abort()
    expect(await running).toMatchObject({ state: "stopped", rows: 1 })

    const bad = createJob(home, jobWork(home, { code: `await click("Nope")` }, "https://s/").work)
    const b2 = fakeBrowser(() => ({ value: "visible" }))
    const failing = async (method: Method, params: Record<string, unknown>, session: string) =>
      method === "act.batch" ? { ok: false, steps: [{ status: "not_found" }], halted: { index: 0, reason: "not_found", detail: 'no "Nope"' } } : b2.call(method, params, session)
    const st = await runJob(home, bad.id, failing)
    expect(st.state).toBe("error")
    expect(st.error).toContain('NOT_FOUND: click: no "Nope"')
    expect(b2.sent.some((s) => s.method === "tab.close" && s.params.id === 7)).toBe(false)
  })

  it("a job without a page to start on fails at once", async () => {
    const def = createJob(home, jobWork(home, { code: "return 1" }).work)
    expect(await runJob(home, def.id, fakeBrowser(() => null).call, { quiet: true })).toMatchObject({ state: "error", error: expect.stringContaining("no page to start on") })
  })
})
