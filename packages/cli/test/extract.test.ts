import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ExtractResult } from "@kitestring/protocol"
import { KiteError } from "../src/client/rpc-client.js"
import { extractPages, extractSummary, saveRows, toCsv } from "../src/client/extract.js"

const page = (rows: Record<string, string>[], extra: Partial<ExtractResult> = {}): ExtractResult => ({
  key: "list:div>div.card",
  source: `list of ${rows.length} div.card`,
  columns: [...new Set(rows.flatMap((r) => Object.keys(r)))],
  rows,
  total: rows.length,
  others: [],
  ...extra,
})

/** A fake extension: page.extract answers from `pages`, a click on next turns to the next one. */
function fake(pages: ExtractResult[], opts: { clickFails?: number } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let at = 0
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === "page.extract") return pages[Math.min(at, pages.length - 1)]
    if (method === "act.click" || method === "act.scroll") {
      if (opts.clickFails === at) return { ok: false, status: "not_found", detail: "no element matches \"Next\"" }
      at++
      return { ok: true, status: "done" }
    }
    throw new Error(`unexpected ${method}`)
  }
  return { call, calls }
}
const noSleep = async () => {}

describe("extractPages", () => {
  it("one page without next", async () => {
    const f = fake([page([{ title: "a" }, { title: "b" }])])
    const x = await extractPages(f.call as never, {}, noSleep)
    expect(x.rows).toEqual([{ title: "a" }, { title: "b" }])
    expect(x.pages).toBe(1)
    expect(f.calls.map((c) => c.method)).toEqual(["page.extract"])
    expect(extractSummary(x)).toBe("2 rows × 1 columns from list of 2 div.card")
  })

  it("pages with next, finds the list again by key, unions columns", async () => {
    const f = fake([page([{ title: "a" }]), page([{ title: "b", price: "1" }]), page([{ title: "c" }])])
    const x = await extractPages(f.call as never, { next: "Next", near: "a", pages: 3 }, noSleep)
    expect(x.rows.map((r) => r.title)).toEqual(["a", "b", "c"])
    expect(x.columns).toEqual(["title", "price"])
    expect(x.pages).toBe(3)
    expect(x.stopped).toBeUndefined()
    expect(f.calls[0]!.params).toMatchObject({ near: "a" })
    expect(f.calls[2]!.params).toEqual({ key: "list:div>div.card", max: 5000 })
    expect(f.calls[1]!.params.target).toEqual({ text: "Next" })
  })

  it("stops when there is no next button", async () => {
    const f = fake([page([{ title: "a" }]), page([{ title: "b" }])], { clickFails: 1 })
    const x = await extractPages(f.call as never, { next: "Next", pages: 5 }, noSleep)
    expect(x.rows.map((r) => r.title)).toEqual(["a", "b"])
    expect(x.stopped).toMatch(/^no next page \(not_found/)
  })

  it("infinite scroll keeps old rows on the page: they are not repeated; no new rows stops", async () => {
    const f = fake([page([{ t: "a" }]), page([{ t: "a" }, { t: "b" }]), page([{ t: "a" }, { t: "b" }])])
    const x = await extractPages(f.call as never, { next: "scroll", pages: 10 }, noSleep)
    expect(x.rows.map((r) => r.t)).toEqual(["a", "b"])
    expect(x.stopped).toBe("page 3 brought no new rows")
    expect(f.calls.find((c) => c.method === "act.scroll")!.params).toEqual({ direction: "down", px: 2000 })
  })

  it("stops at max rows", async () => {
    const f = fake([page([{ t: "a" }, { t: "b" }]), page([{ t: "c" }, { t: "d" }])])
    const x = await extractPages(f.call as never, { next: "Next", max: 3, pages: 5 }, noSleep)
    expect(x.rows.map((r) => r.t)).toEqual(["a", "b", "c"])
    expect(x.stopped).toBe("reached 3 rows")
  })

  it("a page with no data is the caller's error", async () => {
    const call = async () => {
      throw new KiteError("BAD_REQUEST", "no table or repeated list on this page")
    }
    await expect(extractPages(call as never, {}, noSleep)).rejects.toThrow(/no table/)
  })
})

describe("csv and files", () => {
  let dir: string | undefined
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it("quotes commas, quotes and newlines; formulas stay text; missing cells are empty", () => {
    expect(toCsv(["a", "b"], [{ a: 'x,"y"', b: "1\n2" }, { a: "=SUM(A1)" }, { a: "-5", b: "@x" }])).toBe('a,b\n"x,""y""","1\n2"\n\'=SUM(A1),\n-5,\'@x\n')
  })

  it("saves csv, json and jsonl by extension; refuses others", () => {
    dir = mkdtempSync(join(tmpdir(), "kite-extract-"))
    const x = { columns: ["t"], rows: [{ t: "a" }, { t: "b" }] }
    expect(readFileSync(saveRows(x, "out/rows.csv", dir), "utf8")).toBe("t\na\nb\n")
    expect(JSON.parse(readFileSync(saveRows(x, "rows.json", dir), "utf8"))).toEqual(x.rows)
    expect(readFileSync(saveRows(x, "rows.jsonl", dir), "utf8")).toBe('{"t":"a"}\n{"t":"b"}\n')
    expect(() => saveRows(x, "rows.txt", dir!)).toThrow(/\.csv, \.json or \.jsonl/)
  })
})
