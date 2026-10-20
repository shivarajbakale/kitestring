import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BatchResult, Plan } from "@kitestring/protocol"
import { KiteError } from "../src/client/rpc-client.js"
import { formatSchedules } from "../src/client/format.js"
import { savePlan } from "../src/memory/store.js"
import { runDue, runSchedule, type SessionCall } from "../src/schedule/runner.js"
import { addSchedule, formatEvery, loadSchedules, parseEvery, readWatchText, removeSchedule, updateSchedule, type PlanSchedule, type Schedule } from "../src/schedule/store.js"

let home: string
beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "kite-schedule-"))))
afterEach(() => rmSync(home, { recursive: true, force: true }))

const PLAN: Plan = {
  version: 1,
  intent: "download invoices",
  origin: "https://bills.example.com",
  pathPattern: "/invoices",
  params: [{ name: "month", secret: false }],
  batches: [[{ action: "click", target: { text: "{{month}}", role: "link" } }, { action: "click", target: { text: "Download", role: "button" } }]],
  createdAt: "2026-01-01T00:00:00.000Z",
  runs: 0,
  lastOk: null,
}

const ok: BatchResult = { ok: true, steps: [], diff: { added: [], removed: [] }, page: "P" }
const halted: BatchResult = {
  ok: false,
  steps: [],
  halted: { index: 1, reason: "not_found", detail: "no Download button" },
  next: 1,
  diff: { added: [], removed: [] },
  page: "P",
}

/** A fake extension: records each call; act.batch answers `batch`; tab.list says the tab is on the plan's site. */
function fake(batch: BatchResult | Error = ok) {
  const calls: { method: string; params: any; session: string }[] = []
  const call: SessionCall = async (method, params, session) => {
    calls.push({ method, params, session })
    if (method === "tab.new") {
      if (batch instanceof Error) throw batch
      return { id: 42, url: "https://bills.example.com/invoices" }
    }
    if (method === "tab.list") return { tabs: [{ id: 42, url: "https://bills.example.com/invoices", active: true }] }
    if (method === "act.batch") return batch
    return null
  }
  return { calls, call }
}

function schedule(over: Partial<PlanSchedule> = {}): Schedule {
  savePlan(home, PLAN)
  return addSchedule(home, { kind: "plan", plan: "bills-example-com/download-invoices", params: { month: "September" }, everyMs: 86_400_000, nextAt: 0, createdAt: "now", ...over })
}

describe("intervals", () => {
  it("parses and prints m, h, d, w", () => {
    expect(parseEvery("30m")).toBe(30 * 60_000)
    expect(parseEvery("6h")).toBe(6 * 3_600_000)
    expect(formatEvery(parseEvery("1d"))).toBe("1d")
    expect(formatEvery(parseEvery("2w"))).toBe("2w")
    expect(formatEvery(90 * 60_000)).toBe("90m")
  })
  it("refuses bad or too short intervals", () => {
    expect(() => parseEvery("1m")).toThrow(/at least 5m/)
    expect(() => parseEvery("daily")).toThrow(/30m, 6h, 1d or 1w/)
    expect(() => parseEvery("0h")).toThrow()
  })
})

describe("schedule store", () => {
  it("adds with unique ids, patches, removes; the file is owner-only", () => {
    const a = schedule()
    const b = schedule()
    expect([a.id, b.id]).toEqual(["download-invoices", "download-invoices-2"])
    expect(() => schedule({ id: "download-invoices" })).toThrow(/already exists/)
    expect(statSync(join(home, "schedules.json")).mode & 0o777).toBe(0o600)
    updateSchedule(home, a.id, { nextAt: 5 })
    expect(loadSchedules(home).find((s) => s.id === a.id)?.nextAt).toBe(5)
    expect(removeSchedule(home, b.id)).toBe(true)
    expect(removeSchedule(home, b.id)).toBe(false)
    updateSchedule(home, b.id, { nextAt: 9 }) // removed stays removed
    expect(loadSchedules(home).map((s) => s.id)).toEqual([a.id])
  })
})

describe("runSchedule", () => {
  it("replays in a window of its own session, closes it and notifies", async () => {
    const s = schedule()
    const { calls, call } = fake()
    const run = await runSchedule(home, s, call)
    expect(run).toMatchObject({ status: "done" })
    expect(calls[0]).toEqual({ method: "tab.new", params: { url: "https://bills.example.com/invoices", own_window: true }, session: "schedule-download-invoices" })
    const batch = calls.find((c) => c.method === "act.batch")!
    expect(batch.params.steps[0].target).toEqual({ text: "September", role: "link" })
    expect(calls.find((c) => c.method === "tab.close")?.params).toEqual({ id: 42 })
    expect(calls.at(-1)).toMatchObject({ method: "notify", params: { title: "✓ download-invoices" } })
    expect(calls.at(-1)!.params.tab).toBeUndefined()
  })

  it("a stop leaves the tab open and the notification shows it", async () => {
    const s = schedule()
    const { calls, call } = fake(halted)
    const run = await runSchedule(home, s, call)
    expect(run.status).toBe("stopped")
    expect(run.summary).toMatch(/step 2 \(not_found: "Download"\) no Download button/)
    expect(calls.some((c) => c.method === "tab.close")).toBe(false)
    expect(calls.at(-1)).toMatchObject({ method: "notify", params: { title: "download-invoices stopped", tab: 42 } })
  })

  it("paused: skipped, nothing opened, no notification", async () => {
    const s = schedule()
    const { calls, call } = fake(new KiteError("PAUSED", "PAUSED: Kitestring is paused by the user"))
    expect(await runSchedule(home, s, call)).toMatchObject({ status: "skipped" })
    expect(calls.map((c) => c.method)).toEqual(["tab.new"])
  })

  it("a plan that gained a secret is refused before anything runs", async () => {
    const s = schedule()
    savePlan(home, { ...PLAN, params: [...PLAN.params, { name: "otp", secret: true }] })
    const { calls, call } = fake()
    expect(await runSchedule(home, s, call)).toMatchObject({ status: "error", summary: expect.stringMatching(/secret/) })
    expect(calls.map((c) => c.method)).toEqual(["notify"])
  })
})

describe("runDue", () => {
  it("runs only due schedules, books the next run and keeps the result", async () => {
    const due = schedule({ nextAt: 1000 })
    schedule({ nextAt: 10_000 })
    const { call } = fake()
    expect(await runDue(home, call, true, 5000)).toEqual([due.id])
    const after = loadSchedules(home).find((s) => s.id === due.id)!
    expect(after.nextAt).toBe(5000 + 86_400_000)
    expect(after.last).toMatchObject({ status: "done" })
    expect(formatSchedules(loadSchedules(home), 5000)).toMatch(/download-invoices {2}every 1d {2}plan bills-example-com\/download-invoices {2}next in 1d {2}last ✓ done/)
  })

  it("a due run waits while the person is active, up to an hour", async () => {
    const s = schedule({ nextAt: 1000 })
    const { calls, call } = fake()
    expect(await runDue(home, call, false, 1000 + 59 * 60_000)).toEqual([])
    expect(calls).toEqual([])
    expect(await runDue(home, call, false, 1000 + 60 * 60_000)).toEqual([s.id])
  })
})

describe("watch", () => {
  /** A fake extension whose page shows each text of `pages` in turn, one per run (a run reads until two reads agree). */
  function page(pages: string[]) {
    const calls: { method: string; params: any }[] = []
    let run = -1
    const call: SessionCall = async (method, params) => {
      calls.push({ method, params })
      if (method === "tab.new") return run++, { id: 9, url: (params as { url: string }).url }
      if (method === "page.text") return { text: pages[Math.min(run, pages.length - 1)] }
      return null
    }
    return { calls, call }
  }
  const sleep = async () => {}
  const watch = () => addSchedule(home, { kind: "watch", url: "https://visa.example.com/slots", ignore: ["^updated "], everyMs: 3_600_000, nextAt: 0, createdAt: "now" })

  it("is named after the page; keeps its text owner-only and drops it on remove", async () => {
    const w = watch()
    expect(w.id).toBe("visa-example-com-slots")
    const { call } = page(["No slots\nupdated 10:00"])
    await runSchedule(home, w, call, { sleep })
    expect(readWatchText(home, w.id)).toBe("No slots")
    expect(statSync(join(home, "watches", `${w.id}.txt`)).mode & 0o777).toBe(0o600)
    removeSchedule(home, w.id)
    expect(readWatchText(home, w.id)).toBeUndefined()
  })

  it("first read keeps the text, then tells only about changes; ignored lines never count", async () => {
    const w = watch()
    const { calls, call } = page(["No slots\nupdated 10:00", "No slots\nupdated 11:00", "No slots\n1\n3 Nov 09:30 free\nupdated 12:00"])
    const first = await runSchedule(home, w, call, { sleep })
    expect(first).toMatchObject({ status: "done", summary: expect.stringMatching(/^first read: kept 1 lines/) })
    expect(calls[0]).toEqual({ method: "tab.new", params: { url: "https://visa.example.com/slots", background: true } })
    expect(calls.filter((c) => c.method === "notify")).toEqual([
      { method: "notify", params: { title: "Watching visa-example-com-slots", message: first.summary, url: "https://visa.example.com/slots" } },
    ])
    calls.length = 0
    expect(await runSchedule(home, w, call, { sleep })).toMatchObject({ status: "done", summary: "no change" })
    expect(calls.some((c) => c.method === "notify")).toBe(false)
    expect(calls.at(-1)).toMatchObject({ method: "tab.close", params: { id: 9 } })
    const changed = await runSchedule(home, w, call, { sleep })
    expect(changed).toMatchObject({ status: "changed", summary: '+2 −0 lines: "3 Nov 09:30 free"' })
    expect(calls.find((c) => c.method === "notify")?.params.title).toBe("visa-example-com-slots changed")
  })

  it("rereads a page that is still loading until two reads agree", async () => {
    const w = watch()
    const texts = ["Loading", "No slots", "No slots"]
    let n = 0
    const call: SessionCall = async (method) => (method === "tab.new" ? { id: 9 } : method === "page.text" ? { text: texts[Math.min(n++, 2)] } : null)
    await runSchedule(home, w, call, { sleep })
    expect(readWatchText(home, w.id)).toBe("No slots")
    expect(n).toBe(5) // Loading, No slots, No slots (agreed), then the first read's confirming pair
  })

  it("an error is told once, not on every run while it repeats", async () => {
    const w = watch()
    const calls: string[] = []
    const call: SessionCall = async (method) => {
      calls.push(method)
      if (method === "tab.new") throw new KiteError("TIMEOUT", "timed out waiting for the browser")
      return null
    }
    const r1 = await runSchedule(home, w, call, { sleep })
    expect(r1.status).toBe("error")
    expect(calls).toEqual(["tab.new", "notify"])
    calls.length = 0
    await runSchedule(home, { ...w, last: r1 }, call, { sleep })
    expect(calls).toEqual(["tab.new"])
  })

  it("runs when due even while the person is active", async () => {
    const w = watch()
    const { call } = page(["No slots"])
    expect(await runDue(home, call, false, 1000)).toEqual([w.id])
  })

  it("a second run of the same schedule is skipped while the first is on", async () => {
    const w = watch()
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const call: SessionCall = async (method) => {
      if (method === "tab.new") return await gate, { id: 9 }
      return method === "page.text" ? { text: "No slots" } : null
    }
    const first = runSchedule(home, w, call, { sleep })
    expect(await runSchedule(home, w, call, { sleep })).toMatchObject({ status: "skipped", summary: "another run of it is still going" })
    open()
    expect((await first).status).toBe("done")
    expect((await runSchedule(home, w, call, { sleep })).status).toBe("done") // released
  })

  it("a change that a second read 5 s later does not show is no change, and stays out of the baseline", async () => {
    const w = watch()
    // run 1: baseline; run 2: "Assignees" missing in the first read only (drawn late); run 3: an issue really appears
    const reads = [
      ["Issues", "Assignees"], ["Issues", "Assignees"],
      ["Issues"], ["Issues"], ["Issues", "Assignees"], ["Issues", "Assignees"],
      ["Issues", "Assignees", "Kitestring watch test"], ["Issues", "Assignees", "Kitestring watch test"],
    ]
    let n = 0
    const call: SessionCall = async (method) =>
      method === "tab.new" ? { id: 9 } : method === "page.text" ? { text: reads[Math.min(n++, reads.length - 1)]!.join("\n") } : null
    await runSchedule(home, w, call, { sleep })
    n = 2
    expect(await runSchedule(home, w, call, { sleep })).toMatchObject({ status: "done", summary: "no change" })
    expect(readWatchText(home, w.id)).toBe("Issues\nAssignees")
    n = 6
    expect(await runSchedule(home, w, call, { sleep })).toMatchObject({ status: "changed", summary: '+1 −0 lines: "Kitestring watch test"' })
  })

  it("the first read takes in parts a second read 5 s later shows", async () => {
    const w = watch()
    const reads = [["Issues"], ["Issues"], ["Issues", "Assignees"], ["Issues", "Assignees"]]
    let n = 0
    const call: SessionCall = async (method) =>
      method === "tab.new" ? { id: 9 } : method === "page.text" ? { text: reads[Math.min(n++, reads.length - 1)]!.join("\n") } : null
    await runSchedule(home, w, call, { sleep })
    expect(readWatchText(home, w.id)).toBe("Issues\nAssignees")
    expect(await runSchedule(home, w, call, { sleep })).toMatchObject({ status: "done", summary: "no change" })
  })
})

describe("export", () => {
  /** A fake extension whose page lists `runs[i]` on run i (page.extract answers the same rows until the next tab.new). */
  function rows(runs: Record<string, string>[][]) {
    const calls: { method: string; params: any }[] = []
    let run = -1
    const call: SessionCall = async (method, params) => {
      calls.push({ method, params })
      if (method === "tab.new") return run++, { id: 7 }
      if (method === "page.extract") {
        const r = runs[Math.min(run, runs.length - 1)]!
        return { key: "list:ul>li", source: `list of ${r.length} li`, columns: ["t"], rows: r, total: r.length, others: [] }
      }
      if (method === "act.click") return { ok: false, status: "not_found" }
      return null
    }
    return { calls, call }
  }
  const sleep = async () => {}
  const add = (over: object = {}) =>
    addSchedule(home, { kind: "export", url: "https://shop.example.com/orders", format: "csv", everyMs: 86_400_000, nextAt: 0, createdAt: "now", ...over } as never)

  it("saves the rows owner-only in a background tab and tells how many are new", async () => {
    const e = add()
    expect(e.id).toBe("shop-example-com-orders")
    const { calls, call } = rows([[{ t: "a" }, { t: "b" }], [{ t: "a" }, { t: "b" }, { t: "c" }], [{ t: "a" }, { t: "b" }, { t: "c" }]])
    const first = await runSchedule(home, e, call, { sleep })
    expect(first.status).toBe("done")
    expect(first.summary).toMatch(/^2 rows saved to .*exports\/shop-example-com-orders\/.*\.csv$/)
    expect(calls[0]).toEqual({ method: "tab.new", params: { url: "https://shop.example.com/orders", background: true } })
    const file = first.summary.split(" saved to ")[1]!
    expect(readFileSync(file, "utf8")).toBe("t\na\nb\n")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(calls.find((c) => c.method === "notify")?.params.title).toBe("shop-example-com-orders: 2 rows")
    await new Promise((r) => setTimeout(r, 1100)) // a new file name each run (second precision)
    const second = await runSchedule(home, e, call, { sleep })
    expect(second).toMatchObject({ status: "changed", summary: expect.stringMatching(/^3 rows \(1 new\) saved to /) })
    expect(calls.at(-2)).toMatchObject({ method: "tab.close", params: { id: 7 } })
    await new Promise((r) => setTimeout(r, 1100))
    expect((await runSchedule(home, e, call, { sleep })).summary).toMatch(/^3 rows \(0 new\)/)
    expect(readdirSync(join(home, "exports", e.id)).filter((f) => f.endsWith(".csv"))).toHaveLength(3)
  })

  it("paging needs a window in front: such an export waits for the person to be away", async () => {
    const e = add({ next: "Next", pages: 3 })
    const { calls, call } = rows([[{ t: "a" }]])
    expect(await runDue(home, call, false, 1000)).toEqual([])
    expect(await runDue(home, call, true, 1000)).toEqual([e.id])
    expect(calls[0]).toEqual({ method: "tab.new", params: { url: "https://shop.example.com/orders", own_window: true } })
    expect(loadSchedules(home)[0]!.last?.summary).toMatch(/no next page/)
  })

  it("a one-page export runs while the person is active; formatSchedules says export", async () => {
    const e = add()
    expect(formatSchedules([e], 1)).toContain("export https://shop.example.com/orders  due  never run")
    const { call } = rows([[{ t: "a" }]])
    expect(await runDue(home, call, false, 1000)).toEqual([e.id])
  })
})
