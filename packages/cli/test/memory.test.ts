import { mkdtempSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BatchResult, Plan, Step, StepResult } from "@kitestring/protocol"
import { buildPlan, fillPlan } from "../src/memory/build.js"
import { findPlan, forgetPlan, loadPlans, savePlan } from "../src/memory/store.js"

const ok = (i: number, action: string, resolved?: StepResult["resolved"], status: StepResult["status"] = "done"): StepResult => ({
  i,
  action,
  status,
  ms: 1,
  ...(resolved ? { resolved } : {}),
})
const batch = (steps: StepResult[], halted?: BatchResult["halted"]): BatchResult =>
  ({ ok: !halted, steps, ...(halted ? { halted } : {}), diff: {}, page: "" }) as unknown as BatchResult

const URL_ = "https://store.example.com/apps/12345/listing"
const sent: Step[][] = [
  [
    { action: "goto", url: "https://store.example.com/apps/12345/listing?token=abc" },
    { action: "fill", target: "@e3", value: "Super Secret Title" },
    { action: "fill", target: { text: "Title" }, value: "Another Title" },
    { action: "select", target: "@e5", value: "Productivity" },
  ],
  [
    { action: "fill", target: "@e9", value: "hunter2hunter2" },
    { action: "upload", target: "@e10", files: ["/Users/me/icon-secret.png"] },
    { action: "click", target: "@e11" },
    { action: "click", target: "@e12" },
  ],
]
const results: BatchResult[] = [
  batch([
    ok(0, "goto"),
    ok(1, "fill", { role: "textbox", name: "Title" }),
    ok(2, "fill", { role: "textbox", name: "Title", within: "Details" }),
    ok(3, "select", { role: "combobox", name: "Category" }),
  ]),
  batch(
    [
      ok(0, "fill", { role: "textbox", name: "Password" }),
      ok(1, "upload", { role: "button", name: "Icon" }),
      ok(2, "click", { role: "button", name: "Save" }),
      { i: 3, action: "click", status: "not_found", ms: 1 },
    ],
    { index: 3, reason: "not_found" },
  ),
]

describe("buildPlan", () => {
  const plan = buildPlan("Publish store listing", URL_, sent, results, new Set(["1.0"]))

  it("never stores a literal value, file, or url query", () => {
    const json = JSON.stringify(plan)
    for (const v of ["Super Secret Title", "Another Title", "Productivity", "hunter2hunter2", "icon-secret", "token=abc"]) {
      expect(json).not.toContain(v)
    }
  })
  it("records origin, pathPattern and no refs", () => {
    expect(plan.origin).toBe("https://store.example.com")
    expect(plan.pathPattern).toBe("/apps/*/listing")
    expect(JSON.stringify(plan)).not.toMatch(/@e\d/)
    expect(plan.version).toBe(1)
    expect(plan.runs).toBe(0)
    expect(plan.lastOk).toBeNull()
  })
  it("replaces @ref targets by resolved {text, role, within?}", () => {
    const b = plan.batches
    expect(b[0]![1]).toMatchObject({ action: "fill", target: { text: "Title", role: "textbox" }, value: "{{title}}" })
    expect(b[0]![2]).toMatchObject({ target: { text: "Title", role: "textbox", within: "Details" }, value: "{{title_2}}" })
    expect(b[1]![2]).toMatchObject({ action: "click", target: { text: "Save", role: "button" } })
  })
  it("dedupes param names and flags secrets", () => {
    expect(plan.params).toEqual([
      { name: "title", secret: false },
      { name: "title_2", secret: false },
      { name: "category", secret: false },
      { name: "password", secret: true },
      { name: "icon", secret: false },
    ])
    expect(plan.batches[1]![1]).toMatchObject({ action: "upload", files: ["{{icon}}"] })
  })
  it("keeps only steps that ran ok (drops the halted one)", () => {
    expect(plan.batches[1]).toHaveLength(3)
    expect(plan.batches[0]).toHaveLength(4)
  })
  it("drops skipped steps and expectations that echo a value", () => {
    const p = buildPlan(
      "x",
      URL_,
      [[{ action: "fill", target: "@e1", value: "Bob", expect: { text: "Hello Bob" } }, { action: "click", target: "@e2", if_present: true }]],
      [batch([ok(0, "fill", { role: "textbox", name: "Name" }), ok(1, "click", undefined, "skipped")])],
      new Set(),
    )
    expect(p.batches[0]).toHaveLength(1)
    expect(JSON.stringify(p)).not.toContain("Bob")
  })
  it("throws for a ref step with no resolved target", () => {
    expect(() =>
      buildPlan("x", URL_, [[{ action: "click", target: "@e1" }]], [batch([ok(0, "click")])], new Set()),
    ).toThrow(/resolved/)
  })
})

describe("fillPlan", () => {
  const plan = buildPlan("Publish store listing", URL_, sent, results, new Set(["1.0"]))
  it("substitutes values and files", () => {
    const steps = fillPlan(plan, { title: "A", title_2: "B", category: "C", password: "$&p", icon: "/tmp/i.png" })
    expect(steps[0]![1]).toMatchObject({ value: "A" })
    expect(steps[1]![0]).toMatchObject({ value: "$&p" })
    expect(steps[1]![1]).toMatchObject({ files: ["/tmp/i.png"] })
    expect(JSON.stringify(plan)).toContain("{{title}}")
  })
  it("throws on a missing value", () => {
    expect(() => fillPlan(plan, { title: "A" })).toThrow("missing parameter: title_2")
  })
})

describe("store", () => {
  let home: string
  beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "kite-mem-"))))
  afterEach(() => rmSync(home, { recursive: true, force: true }))
  const mk = (intent: string, origin = "https://a.example.com"): Plan => ({
    version: 1, intent, origin, pathPattern: "/", params: [], batches: [[{ action: "press", key: "Enter" }]],
    createdAt: "2026-01-01T00:00:00.000Z", runs: 0, lastOk: null,
  })

  it("writes 0600 files in 0700 dirs, atomically", () => {
    const p = savePlan(home, mk("publish listing"))
    expect(p).toBe(join(home, "memory", "a-example-com", "publish-listing.json"))
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, "memory")).mode & 0o777).toBe(0o700)
    expect(statSync(join(home, "memory", "a-example-com")).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(home, "memory", "a-example-com"))).toEqual(["publish-listing.json"])
    expect(loadPlans(home)).toHaveLength(1)
  })
  it("loadPlans filters by origin and skips junk and .pending", () => {
    savePlan(home, mk("one"))
    savePlan(home, mk("two", "https://b.example.com"))
    writeFileSync(join(home, "memory", "a-example-com", "bad.json"), "{nope")
    savePlan(home, mk("three"))
    expect(loadPlans(home, "https://a.example.com").map((p) => p.intent).sort()).toEqual(["one", "three"])
    expect(loadPlans(home)).toHaveLength(3)
  })
  it("findPlan picks the best overlap >= 0.6 and nothing below", () => {
    savePlan(home, mk("publish store listing"))        // vs query: 3/4 = 0.75
    savePlan(home, mk("publish listing now please"))   // 2/5 -> below
    savePlan(home, mk("publish store"))                // 2/3 vs {publish,store,listing,fast}? see below
    const hit = findPlan(home, "https://a.example.com", "publish the store listing")
    expect(hit?.plan.intent).toBe("publish store listing")
    expect(hit?.score).toBeCloseTo(1, 5)
    const hit2 = findPlan(home, "https://a.example.com", "publish store listing fast")
    expect(hit2?.plan.intent).toBe("publish store listing")
    expect(hit2?.score).toBeCloseTo(0.75, 5)
    expect(findPlan(home, "https://a.example.com", "delete my account")).toBeUndefined()
    expect(findPlan(home, "https://other.example.com", "publish store listing")).toBeUndefined()
  })
  it("a 0.5 plan is rejected", () => {
    savePlan(home, mk("alpha beta"))
    expect(findPlan(home, "https://a.example.com", "alpha beta gamma delta")).toBeUndefined() // 0.5
  })
  it("forgetPlan removes by slug and refuses traversal", () => {
    savePlan(home, mk("one"))
    expect(forgetPlan(home, "../one")).toBe(false)
    expect(forgetPlan(home, "nope")).toBe(false)
    expect(forgetPlan(home, "one")).toBe(true)
    expect(loadPlans(home)).toHaveLength(0)
  })
  it("forgetPlan with a slug in two origins needs the qualified form", () => {
    savePlan(home, mk("one"))
    savePlan(home, mk("one", "https://b.example.com"))
    expect(() => forgetPlan(home, "one")).toThrow(/ambiguous/)
    expect(forgetPlan(home, "b-example-com/one")).toBe(true)
    expect(JSON.parse(readFileSync(join(home, "memory", "a-example-com", "one.json"), "utf8")).intent).toBe("one")
  })
})
