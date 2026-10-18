import { mkdirSync, mkdtempSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BatchResult, Plan, Step, StepResult } from "@kitestring/protocol"
import { buildPlan, fillPlan } from "../src/memory/build.js"
import { findPlan, forgetPlan, listPlans, loadPlans, savePlan } from "../src/memory/store.js"

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
      buildPlan("x", URL_, [[{ action: "click", target: "@e00001" }]], [batch([ok(0, "click")])], new Set()),
    ).toThrow(/@ref/)
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
    expect(() => fillPlan(plan, { title: "A" })).toThrow("missing parameters: title_2, category, password, icon")
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
    mkdirSync(join(home, "memory", ".pending"), { recursive: true })
    writeFileSync(join(home, "memory", ".pending", "default.json"), JSON.stringify(mk("pending one")))
    savePlan(home, mk("three"))
    expect(loadPlans(home, "https://a.example.com").map((p) => p.intent).sort()).toEqual(["one", "three"])
    expect(loadPlans(home)).toHaveLength(3)
    expect(listPlans(home).map((x) => x.id)).toEqual(["a-example-com/one", "a-example-com/three", "b-example-com/two"])
  })
  it("findPlan picks the best overlap >= 0.6 and nothing below", () => {
    savePlan(home, mk("publish store listing"))
    savePlan(home, mk("publish listing now please"))
    savePlan(home, mk("publish store"))
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

describe("buildPlan never echoes a value", () => {
  const R = (role: string, name: string, within?: string) => ({ role, name, ...(within ? { within } : {}) })
  const build = (steps: Step[], rs: StepResult[], url = URL_) => buildPlan("x", url, [steps], [batch(rs)], new Set())

  it("parameterizes an option clicked after the same value was typed", () => {
    const p = build(
      [
        { action: "fill", target: "@e1", value: "Productivity" },
        { action: "click", target: "@e2" },
      ],
      [ok(0, "fill", R("combobox", "Category")), ok(1, "click", R("option", "productivity apps"))],
    )
    expect(JSON.stringify(p)).not.toMatch(/productivity/i)
    expect((p.batches[0]![1] as any).target.text).toBe("{{category}}")
  })
  it("echo in within, from a failed step, and case-insensitively", () => {
    const p = build(
      [
        { action: "fill", target: "@e1", value: "Super   Secret" },
        { action: "fill", target: "@e1", value: "Zed Zebra" },
        { action: "click", target: "@e2" },
      ],
      [ok(0, "fill", R("textbox", "Name")), { i: 1, action: "fill", status: "error", ms: 1 }, ok(2, "click", R("button", "Edit", "SUPER SECRET row"))],
    )
    const j = JSON.stringify(p)
    expect(j).not.toMatch(/super/i)
    expect((p.batches[0]![1] as any).target.within).toBe("{{name}}")
  })
  it("upload basename echoed in expect is dropped", () => {
    const p = build(
      [{ action: "upload", target: "@e1", files: ["/x/icon-secret.png"], expect: { text: "ICON-SECRET.png uploaded" } }],
      [ok(0, "upload", R("button", "Icon"))],
    )
    expect(JSON.stringify(p)).not.toMatch(/icon-secret|uploaded/i)
  })
  it("choice roles become params even with no prior fill; radios stay literal", () => {
    const p = build(
      [{ action: "click", target: "@e1" }, { action: "click", target: "@e2" }],
      [ok(0, "click", R("option", "Blue", "Colour")), ok(1, "click", R("radio", "Monthly"))],
    )
    expect(p.batches[0]![0]).toMatchObject({ target: { text: "{{colour}}", role: "option" } })
    expect(p.batches[0]![1]).toMatchObject({ target: { text: "Monthly" } })
    expect(p.params.map((x) => x.name)).toEqual(["colour"])
  })
  it("goto: echoing path segment becomes a param, query dropped and marked", () => {
    const p = build(
      [{ action: "fill", target: "@e1", value: "hunter2" }, { action: "goto", url: "https://x.example.com/search/hunter2/view?tab=a#f" }],
      [ok(0, "fill", R("textbox", "Query")), ok(1, "goto")],
      "https://x.example.com/search/hunter2",
    )
    expect(p.batches[0]![1]).toEqual({ action: "goto", url: "https://x.example.com/search/{{query}}/view", droppedQuery: true })
    expect(p.pathPattern).toBe("/search/*")
    expect(fillPlan(p, { query: "cats" })[0]![1]).toEqual({ action: "goto", url: "https://x.example.com/search/cats/view" })
  })
  it("copies by allowlist, folds step within/role into plain-text targets", () => {
    const p = build(
      [{ action: "click", target: "Save", within: "Form", role: "button", note: "leak me" } as unknown as Step],
      [ok(0, "click")],
    )
    expect(p.batches[0]![0]).toEqual({ action: "click", target: { text: "Save", role: "button", within: "Form" } })
  })
  it("throws only for an @ref with no resolved", () => {
    expect(() => build([{ action: "click", target: { ref: "@e1" } }], [ok(0, "click")])).toThrow(/@ref/)
  })
  it("press: named keys literal, a single printable char is a param", () => {
    const p = build(
      [{ action: "press", key: "Enter" }, { action: "press", key: "Control+a" }, { action: "press", key: "7" }],
      [ok(0, "press"), ok(1, "press"), ok(2, "press")],
    )
    expect(p.batches[0]!.map((s: any) => s.key)).toEqual(["Enter", "Control+a", "{{key}}"])
    expect(fillPlan(p, { key: "7" })[0]![2]).toMatchObject({ key: "7" })
  })
})

describe("savePlan merge", () => {
  let home: string
  beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "kite-mem-"))))
  afterEach(() => rmSync(home, { recursive: true, force: true }))
  const mk = (intent: string, extra: Partial<Plan> = {}): Plan => ({
    version: 1, intent, origin: "https://a.example.com", pathPattern: "/", params: [], batches: [],
    createdAt: "2026-02-02T00:00:00.000Z", runs: 1, lastOk: null, ...extra,
  })
  it("keeps createdAt, adds runs, keeps lastOk unless new", () => {
    savePlan(home, mk("one", { createdAt: "2026-01-01T00:00:00.000Z", lastOk: "2026-01-05T00:00:00.000Z" }))
    savePlan(home, mk("one"))
    let p = loadPlans(home)[0]!
    expect([p.createdAt, p.runs, p.lastOk]).toEqual(["2026-01-01T00:00:00.000Z", 2, "2026-01-05T00:00:00.000Z"])
    savePlan(home, mk("one", { lastOk: "2026-03-03T00:00:00.000Z" }))
    p = loadPlans(home)[0]!
    expect(p.lastOk).toBe("2026-03-03T00:00:00.000Z")
  })
  it("a truncation collision gets a hash suffix instead of overwriting", () => {
    const long = "publish the listing of the store for my application number ".repeat(2)
    savePlan(home, mk(long + "alpha"))
    savePlan(home, mk(long + "beta"))
    const plans = loadPlans(home)
    expect(plans.map((x) => x.intent).sort()).toEqual([long + "alpha", long + "beta"])
    expect(listPlans(home).some((x) => /-[0-9a-f]{4}$/.test(x.id))).toBe(true)
  })
})

describe("own-value names and safe goto params", () => {
  const R = (role: string, name: string, within?: string) => ({ role, name, ...(within ? { within } : {}) })
  it("a combobox named after its own value stores no name and no param named after it", () => {
    const p = buildPlan(
      "x", URL_,
      [[{ action: "fill", target: "@e1", value: "Productivity" }]],
      [batch([ok(0, "fill", R("combobox", "Productivity", "Productivity group"))])],
      new Set(),
    )
    expect(JSON.stringify(p)).not.toMatch(/productivity/i)
    expect(p.batches[0]![0]).toMatchObject({ target: { role: "combobox" }, value: "{{combobox}}" })
    expect((p.batches[0]![0] as any).target.text).toBeUndefined()
    expect(p.params).toEqual([{ name: "combobox", secret: false }])
  })
  it("a choice click does not name its param from an echoing within", () => {
    const p = buildPlan(
      "x", URL_,
      [[{ action: "fill", target: "@e1", value: "Gold" }, { action: "click", target: "@e2" }]],
      [batch([ok(0, "fill", R("textbox", "Tier")), ok(1, "click", R("option", "Silver", "Gold plans"))])],
      new Set(),
    )
    expect(JSON.stringify(p)).not.toMatch(/gold/i)
    expect(p.params.map((x) => x.name)).toEqual(["tier", "option"])
  })
  const gotoPlan = (url: string): Plan => ({
    version: 1, intent: "g", origin: "https://x.example.com", pathPattern: "/", params: [{ name: "q", secret: false }],
    batches: [[{ action: "goto", url }]], createdAt: "", runs: 0, lastOk: null,
  })
  it("goto values are encoded as one path segment", () => {
    const g = (v: string) => (fillPlan(gotoPlan("https://x.example.com/s/{{q}}/v"), { q: v })[0]![0] as any).url
    expect(g("../etc")).toBe("https://x.example.com/s/..%2Fetc/v")
    expect(g("a?x=1#f")).toBe("https://x.example.com/s/a%3Fx%3D1%23f/v")
    expect(g("https://evil.com/")).toBe("https://x.example.com/s/https%3A%2F%2Fevil.com%2F/v")
    expect(g("..")).toBe("https://x.example.com/s/%2E%2E/v")
  })
  it("throws BAD_REQUEST when the url leaves the plan origin", () => {
    expect(() => fillPlan(gotoPlan("{{q}}"), { q: "https://evil.com/" })).toThrow(/not on https:\/\/x.example.com/)
    expect(() => fillPlan(gotoPlan("{{q}}"), { q: "https://evil.com/" })).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }))
  })
})
