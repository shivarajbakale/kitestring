import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BatchResult, Plan } from "@kitestring/protocol"
import { KiteError } from "../src/client/rpc-client.js"
import { formatSchedules } from "../src/client/format.js"
import { savePlan } from "../src/memory/store.js"
import { runDue, runSchedule, type SessionCall } from "../src/schedule/runner.js"
import { addSchedule, formatEvery, loadSchedules, parseEvery, removeSchedule, updateSchedule, type Schedule } from "../src/schedule/store.js"

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

function schedule(over: Partial<Schedule> = {}): Schedule {
  savePlan(home, PLAN)
  return addSchedule(home, { plan: "bills-example-com/download-invoices", params: { month: "September" }, everyMs: 86_400_000, nextAt: 0, createdAt: "now", ...over })
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
