import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BatchResult, Plan, StepResult } from "@kitestring/protocol"
import { KiteError } from "../src/client/rpc-client.js"
import { runPlan } from "../src/memory/replay.js"
import { listPlans, savePlan } from "../src/memory/store.js"

let home: string
beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "kite-replay-"))))
afterEach(() => rmSync(home, { recursive: true, force: true }))

const PLAN: Plan = {
  version: 1,
  intent: "publish store listing",
  origin: "https://dash.example.com",
  pathPattern: "/items/*/edit",
  params: [
    { name: "title", secret: false },
    { name: "password", secret: true },
    { name: "summary", secret: false },
  ],
  batches: [
    [
      { action: "goto", url: "https://dash.example.com/items/new", droppedQuery: true },
      { action: "fill", target: { text: "Title", role: "textbox" }, value: "{{title}}" },
      { action: "fill", target: { text: "Password", role: "textbox" }, value: "{{password}}" },
    ],
    [
      { action: "fill", target: { text: "Short description", role: "textbox" }, value: "{{summary}}" },
      { action: "click", target: { text: "Save draft", role: "button" } },
    ],
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  runs: 2,
  lastOk: null,
}
const VALUES = { title: "My kite", password: "hunter2-pass", summary: "Flies high" }

const okBatch = (n: number, cached = false): BatchResult => ({
  ok: true,
  steps: Array.from({ length: n }, (_, i) => ({ i, action: "fill", status: "done", ms: 1, ...(cached ? { cached: true } : {}) }) as StepResult),
  diff: { added: [], removed: [] },
  page: "P",
})
const halted = (n: number, index: number, reason: any, detail: string, extra: Partial<StepResult> = {}): BatchResult => ({
  ok: false,
  steps: Array.from({ length: index + 1 }, (_, i) => ({ i, action: "fill", status: i === index ? "not_found" : "done", ms: 1, ...(i === index ? extra : {}) }) as StepResult),
  halted: { index, reason, detail },
  next: index,
  diff: { added: [], removed: [] },
  page: "P",
})

/** A fake RPC answering act.batch with the given results in order; records every call. */
function fake(answers: BatchResult[]) {
  const calls: { method: string; params: any }[] = []
  return {
    calls,
    call: async (method: string, params: object) => {
      calls.push({ method, params })
      const a = answers.shift()
      if (!a) throw new Error("no more answers")
      return a
    },
  }
}

describe("runPlan", () => {
  it("all params: every batch runs, ok, runs and lastOk bumped", async () => {
    const file = savePlan(home, PLAN)
    const rpc = fake([okBatch(3), okBatch(2, true)])
    const lines: string[] = []
    const r = await runPlan(PLAN, VALUES, { call: rpc.call as any, out: (s) => lines.push(s), home })
    expect(r.ok).toBe(true)
    expect(r.batches).toBe(2)
    expect(r.stoppedAt).toBeUndefined()
    expect(r.cached).toBe(2)
    expect(rpc.calls.map((c) => c.method)).toEqual(["act.batch", "act.batch"])
    expect(rpc.calls[0]!.params.steps[1]).toEqual({ action: "fill", target: { text: "Title", role: "textbox" }, value: "My kite" })
    expect(rpc.calls[0]!.params.steps[0]).toEqual({ action: "goto", url: "https://dash.example.com/items/new" })
    expect(lines).toContain("note: query string was not stored for https://dash.example.com/items/new")
    const saved = JSON.parse(readFileSync(file, "utf8")) as Plan
    expect(saved.runs).toBe(3)
    expect(saved.lastOk).toMatch(/^\d{4}-/)
    expect(saved.createdAt).toBe(PLAN.createdAt)
  })

  it("missing params: lists every name, sends nothing", async () => {
    const rpc = fake([])
    const r = await runPlan(PLAN, { title: "x" }, { call: rpc.call as any, home })
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(["password", "summary"])
    expect(r.stoppedAt?.reason).toBe("missing_param")
    expect(rpc.calls).toEqual([])
  })

  it("an unknown param is BAD_REQUEST, nothing sent", async () => {
    const rpc = fake([])
    const e = await runPlan(PLAN, { ...VALUES, titel: "x" }, { call: rpc.call as any, home }).catch((x) => x)
    expect(e).toBeInstanceOf(KiteError)
    expect(e.code).toBe("BAD_REQUEST")
    expect(e.message).toContain("titel")
    expect(rpc.calls).toEqual([])
  })

  it("a changed page: stops at the broken step, says where and why, plan file unchanged", async () => {
    const file = savePlan(home, PLAN)
    const before = readFileSync(file, "utf8")
    const rpc = fake([okBatch(3), halted(2, 0, "not_found", 'no element matches "Short description"')])
    const r = await runPlan(PLAN, VALUES, { call: rpc.call as any, home })
    expect(r.ok).toBe(false)
    expect(r.batches).toBe(2)
    expect(r.stoppedAt).toEqual({ batch: 1, step: 0, reason: "not_found", detail: 'no element matches "Short description"', stepText: '"Short description"' })
    expect(r.result?.halted?.reason).toBe("not_found")
    expect(readFileSync(file, "utf8")).toBe(before)
  })

  it("a replayed click whose name is now risky halts risky and is not continued", async () => {
    const plan: Plan = { ...PLAN, params: [], batches: [[{ action: "click", target: { text: "Save", role: "button" } }], [{ action: "click", target: { text: "Done", role: "button" } }]] }
    const rpc = fake([halted(1, 0, "risky", 'click "Publish" looks irreversible', { action: "click", resolved: { role: "button", name: "Publish" } })])
    const r = await runPlan(plan, {}, { call: rpc.call as any, home })
    expect(r.stoppedAt).toMatchObject({ batch: 0, step: 0, reason: "risky", stepText: '"Save"' })
    expect(rpc.calls).toHaveLength(1)
    expect(listPlans(home)).toEqual([])
  })

  it("a role-only step: the steps before it run, then it hands over with needs_agent", async () => {
    const plan: Plan = {
      ...PLAN,
      params: [{ name: "a", secret: false }, { name: "textbox", secret: false }],
      batches: [
        [
          { action: "fill", target: { text: "A", role: "textbox" }, value: "{{a}}" },
          { action: "fill", target: { role: "textbox", within: "Shipping" }, value: "{{textbox}}" },
          { action: "click", target: { text: "Next", role: "button" } },
        ],
        [{ action: "click", target: { text: "Done", role: "button" } }],
      ],
    }
    const rpc = fake([okBatch(1)])
    const r = await runPlan(plan, { a: "1", textbox: "2" }, { call: rpc.call as any, home })
    expect(rpc.calls).toHaveLength(1)
    expect(rpc.calls[0]!.params.steps).toHaveLength(1)
    expect(r.stoppedAt).toEqual({ batch: 0, step: 1, reason: "needs_agent", detail: "field name not stored (it matched a typed value)", stepText: "fill textbox in Shipping" })
  })

  it("dry run prints the filled batches with secrets masked and sends nothing", async () => {
    const rpc = fake([])
    const lines: string[] = []
    const r = await runPlan(PLAN, VALUES, { call: rpc.call as any, out: (s) => lines.push(s), dryRun: true, secretNames: new Set(["summary"]), home })
    expect(r.ok).toBe(true)
    expect(rpc.calls).toEqual([])
    const text = lines.join("\n")
    expect(text).toContain("My kite")
    expect(text).toContain("••••")
    expect(text).not.toContain("hunter2-pass")
    expect(text).not.toContain("Flies high")
  })

  it("an upload replays only files given as params, through the deny list", async () => {
    const plan: Plan = { ...PLAN, params: [{ name: "file", secret: false }], batches: [[{ action: "upload", target: { text: "Icon", role: "button" }, files: ["{{file}}"] }]] }
    const rpc = fake([])
    const e = await runPlan(plan, { file: join(process.env.HOME ?? "/", ".ssh", "id_rsa") }, { call: rpc.call as any, home }).catch((x) => x)
    expect(e).toBeInstanceOf(KiteError)
    expect(rpc.calls).toEqual([])
  })
})
