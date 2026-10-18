import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BatchResult, Plan, Step, StepResult } from "@kitestring/protocol"
import { buildPlan } from "../src/memory/build.js"
import {
  PENDING_MAX_STEPS,
  appendPending,
  discardPending,
  planFromPending,
  recordReplayStop,
  savePending,
  takePending,
} from "../src/memory/pending.js"
import { listPlans, savePlan } from "../src/memory/store.js"

let home: string
beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "kite-pending-"))))
afterEach(() => rmSync(home, { recursive: true, force: true }))

const URL0 = "https://shop.example.com/login"
const pendingFile = (session = "default") => join(home, "memory", ".pending", `${session}.json`)
const res = (steps: Partial<StepResult>[], extra: Partial<BatchResult> = {}): BatchResult => ({
  ok: steps.every((s) => (s.status ?? "done") === "done"),
  steps: steps.map((s, i) => ({ i, action: "fill", status: "done", ms: 1, ...s }) as StepResult),
  diff: { added: [], removed: [] },
  page: "P",
  ...extra,
})

const LOGIN: Step[] = [
  { action: "fill", target: "Email", value: "ada@secret-mail.io" },
  { action: "fill", target: "Password", value: "hunter2-pass" },
  { action: "click", target: "Sign in" },
]
const LOGIN_RES = res([
  { resolved: { role: "textbox", name: "Email" } },
  { resolved: { role: "textbox", name: "Password" }, secret: true },
  { action: "click", resolved: { role: "button", name: "Sign in" } },
])
const SHIP: Step[] = [
  { action: "fill", target: "Full name", value: "Ada Lovelace" },
  { action: "click", target: "Continue" },
]
const SHIP_RES = res([
  { resolved: { role: "textbox", name: "Full name" } },
  { action: "click", resolved: { role: "button", name: "Continue" } },
])

describe("pending journal", () => {
  it("two ok batches with a typed email and a password: no value on disk, 0600, secret from the result", () => {
    expect(appendPending(home, "default", URL0, LOGIN, LOGIN_RES)).toBeUndefined()
    expect(appendPending(home, "default", "https://shop.example.com/ship", SHIP, SHIP_RES)).toBeUndefined()
    const raw = readFileSync(pendingFile(), "utf8")
    for (const v of ["ada@secret-mail.io", "hunter2-pass", "Ada Lovelace", "ada lovelace", "hunter2"]) expect(raw).not.toContain(v)
    expect(statSync(pendingFile()).mode & 0o777).toBe(0o600)
    expect(JSON.parse(raw).seen).toHaveLength(2) // email and full name; never even a hash of the password
    expect(statSync(join(home, "memory", ".pending")).mode & 0o777).toBe(0o700)
    const p = takePending(home, "default")!
    expect(p.origin).toBe("https://shop.example.com")
    expect(p.params).toEqual([
      { name: "email", secret: false },
      { name: "password", secret: true },
      { name: "full_name", secret: false },
    ])
    expect(p.batches).toHaveLength(2)
  })

  it("save produces the plan buildPlan makes of the same run and clears pending", () => {
    appendPending(home, "default", URL0, LOGIN, LOGIN_RES)
    appendPending(home, "default", "https://shop.example.com/ship", SHIP, SHIP_RES)
    const p = takePending(home, "default")!
    expect(existsSync(pendingFile())).toBe(false)
    const plan = planFromPending("log in and ship", p)
    const direct = buildPlan("log in and ship", URL0, [LOGIN, SHIP], [LOGIN_RES, SHIP_RES], new Set(["0.1"]))
    expect({ ...plan, createdAt: "" }).toEqual({ ...direct, createdAt: "" })
    expect(takePending(home, "default")).toBeUndefined()
  })

  it("param names stay unique across batches", () => {
    const one: Step[] = [{ action: "fill", target: "Name", value: "first value" }]
    const r = res([{ resolved: { role: "textbox", name: "Name" } }])
    appendPending(home, "s", URL0, one, r)
    appendPending(home, "s", URL0, [{ action: "fill", target: "Name", value: "second value" }], r)
    const p = takePending(home, "s")!
    expect(p.params.map((x) => x.name)).toEqual(["name", "name_2"])
    expect(p.batches[1]![0]).toMatchObject({ value: "{{name_2}}" })
  })

  it("a later batch's target named after an earlier typed value becomes a role-named param (salted hashes only)", () => {
    appendPending(home, "default", URL0, [{ action: "fill", target: "City", value: "Berlin" }], res([{ resolved: { role: "combobox", name: "City" } }]))
    const after1 = JSON.parse(readFileSync(pendingFile(), "utf8"))
    expect(typeof after1.salt).toBe("string")
    expect(JSON.stringify(after1).toLowerCase()).not.toContain("berlin")
    appendPending(
      home,
      "default",
      URL0,
      [
        { action: "click", target: "  BERLIN " },
        { action: "fill", target: "berlin", value: "x" },
        { action: "goto", url: "https://shop.example.com/city/Berlin/info" },
      ],
      res([
        { action: "click", resolved: { role: "link", name: "  BERLIN " } },
        { resolved: { role: "textbox", name: "berlin", within: "Berlin" } },
        { action: "goto" },
      ]),
    )
    const raw = readFileSync(pendingFile(), "utf8")
    expect(raw.toLowerCase()).not.toContain("berlin")
    const p = takePending(home, "default")!
    expect(p.batches[1]![0]).toMatchObject({ action: "click", target: { text: "{{link}}", role: "link" } })
    expect(p.batches[1]![1]).toEqual({ action: "fill", target: { role: "textbox" }, value: "{{textbox}}" })
    expect(p.batches[1]![2]).toMatchObject({ action: "goto", url: "https://shop.example.com/city/{{link}}/info" })
    expect(p.params.map((x) => x.name).sort()).toEqual(["city", "link", "textbox"])
  })

  it("only ok steps are kept; a batch with none adds nothing", () => {
    appendPending(home, "default", URL0, SHIP, res([{ resolved: { role: "textbox", name: "Full name" } }, { action: "click", status: "not_found" }]))
    appendPending(home, "default", URL0, [{ action: "click", target: "Gone" }], res([{ action: "click", status: "not_found" }]))
    const p = takePending(home, "default")!
    expect(p.batches).toEqual([[{ action: "fill", target: { text: "Full name", role: "textbox" }, value: "{{full_name}}" }]])
  })

  it("a step memory cannot store skips that batch with a one-line note, never throws", () => {
    const note = appendPending(
      home,
      "default",
      URL0,
      [{ action: "fill", target: "Ada", value: "Ada" }],
      res([{ resolved: { role: "", name: "Ada" } }]),
    )
    expect(note).toMatch(/^not remembered: .*no role/)
    expect(note).not.toContain("\n")
    expect(takePending(home, "default")).toBeUndefined()
  })

  it(`stops recording past ${PENDING_MAX_STEPS} steps`, () => {
    const many: Step[] = Array.from({ length: 50 }, () => ({ action: "click", target: "Next" }) as Step)
    const r = res(many.map(() => ({ action: "click", resolved: { role: "button", name: "Next" } })))
    for (let k = 0; k < 4; k++) expect(appendPending(home, "default", URL0, many, r)).toBeUndefined()
    expect(appendPending(home, "default", URL0, many, r)).toMatch(/full/)
    expect(takePending(home, "default")!.batches.flat()).toHaveLength(PENDING_MAX_STEPS)
  })

  it("discard deletes the file; session names cannot escape the directory", () => {
    appendPending(home, "../evil", URL0, SHIP, SHIP_RES)
    expect(readdirSync(join(home, "memory", ".pending"))).toHaveLength(1)
    expect(discardPending(home, "../evil")).toBe(true)
    expect(discardPending(home, "../evil")).toBe(false)
    expect(readdirSync(join(home, "memory", ".pending"))).toHaveLength(0)
  })

  it("a batch on another site starts a new task memory", () => {
    appendPending(home, "default", URL0, LOGIN, LOGIN_RES)
    const note = appendPending(home, "default", "https://other.example.org/form", SHIP, SHIP_RES)
    expect(note).toBe("started a new task memory (new site https://other.example.org; dropped 3 steps from https://shop.example.com)")
    const p = takePending(home, "default")!
    expect(p.origin).toBe("https://other.example.org")
    expect(p.batches).toHaveLength(1)
    expect(p.params.map((x) => x.name)).toEqual(["full_name"])
  })

  it("a batch more than 30 min after the last starts a new task memory", () => {
    appendPending(home, "default", URL0, LOGIN, LOGIN_RES)
    const f = JSON.parse(readFileSync(pendingFile(), "utf8"))
    expect(Date.parse(f.updatedAt)).toBeGreaterThan(Date.now() - 5_000)
    f.updatedAt = new Date(Date.now() - 31 * 60_000).toISOString()
    writeFileSync(pendingFile(), JSON.stringify(f))
    expect(appendPending(home, "default", URL0, SHIP, SHIP_RES)).toMatch(/^started a new task memory \(over 30 min since the last batch; dropped 3 steps\)$/)
    expect(takePending(home, "default")!.batches).toHaveLength(1)
  })

  it("a whole batch resent after a halt does not journal its ok steps twice", () => {
    const steps: Step[] = [
      { action: "click", target: "Add item" },
      { action: "fill", target: "Full name", value: "Ada Lovelace" },
      { action: "click", target: "Continue" },
    ]
    const r = (n: number, halt?: number): BatchResult =>
      res(
        [
          { action: "click", resolved: { role: "button", name: "Add item" } },
          { resolved: { role: "textbox", name: "Full name" } },
          { action: "click", resolved: { role: "button", name: "Continue" } },
        ].slice(0, n).map((x, i) => (i === halt ? { ...x, status: "not_found" as const } : x)),
        halt !== undefined ? { ok: false, halted: { index: halt, reason: "not_found" } } : {},
      )
    appendPending(home, "default", URL0, steps, r(3, 2)) // Continue not found
    appendPending(home, "default", URL0, steps, r(3)) // the agent resends everything
    const p = takePending(home, "default")!
    expect(p.batches.flat().map((x) => x.action)).toEqual(["click", "fill", "click"])
    expect(p.params.map((x) => x.name)).toEqual(["full_name"])
    expect(JSON.stringify(p.batches)).toContain("{{full_name}}")
  })

  it("saving after taking over from a stopped replay stitches the plan's done part to the takeover", () => {
    const stored: Plan = {
      version: 1, intent: "log in and ship", origin: "https://shop.example.com", pathPattern: "/login",
      params: [{ name: "email", secret: false }, { name: "password", secret: true }, { name: "full_name", secret: false }, { name: "old_field", secret: false }],
      batches: [
        [
          { action: "fill", target: { text: "Email", role: "textbox" }, value: "{{email}}" },
          { action: "fill", target: { text: "Password", role: "textbox" }, value: "{{password}}" },
          { action: "click", target: { text: "Sign in", role: "button" } },
        ],
        [
          { action: "fill", target: { text: "Full name", role: "textbox" }, value: "{{full_name}}" },
          { action: "fill", target: { text: "Old field", role: "textbox" }, value: "{{old_field}}" },
        ],
      ],
      createdAt: "2026-01-01T00:00:00.000Z", runs: 4, lastOk: "2026-02-01T00:00:00.000Z",
    }
    savePlan(home, stored)
    recordReplayStop(home, "default", "shop-example-com/log-in-and-ship", stored, { batch: 1, step: 1 })
    // the agent takes over: the renamed field, a fresh value named like an existing param, then continue
    appendPending(
      home, "default", "https://shop.example.com/ship",
      [{ action: "fill", target: "Email", value: "x@y.io" }, { action: "fill", target: "New field", value: "v1" }, { action: "click", target: "Continue" }],
      res([
        { resolved: { role: "textbox", name: "Email" } },
        { resolved: { role: "textbox", name: "New field" } },
        { action: "click", resolved: { role: "button", name: "Continue" } },
      ]),
    )
    const saved = savePending(home, "default", "log in & ship")!
    expect(saved.updated).toBe(true)
    expect(saved.id).toBe("shop-example-com/log-in-and-ship")
    const [only] = listPlans(home)
    expect(listPlans(home)).toHaveLength(1)
    const p = only!.plan
    expect(p.intent).toBe("log in and ship")
    expect(p.runs).toBe(4)
    expect(p.createdAt).toBe(stored.createdAt)
    expect(p.batches).toEqual([
      stored.batches[0],
      [stored.batches[1]![0]],
      [
        { action: "fill", target: { text: "Email", role: "textbox" }, value: "{{email_2}}" },
        { action: "fill", target: { text: "New field", role: "textbox" }, value: "{{new_field}}" },
        { action: "click", target: { text: "Continue", role: "button" } },
      ],
    ])
    expect(p.params).toEqual([
      { name: "email", secret: false },
      { name: "password", secret: true },
      { name: "full_name", secret: false },
      { name: "email_2", secret: false },
      { name: "new_field", secret: false },
    ])
    expect(existsSync(pendingFile())).toBe(false)
  })

  const STORED: Plan = {
    version: 1, intent: "add an item and ship", origin: "https://shop.example.com", pathPattern: "/cart",
    params: [{ name: "full_name", secret: false }],
    batches: [[
      { action: "click", target: { text: "Add item", role: "button" } },
      { action: "fill", target: { text: "Full name", role: "textbox" }, value: "{{full_name}}" },
      { action: "click", target: { text: "Continue", role: "button" } },
    ]],
    createdAt: "2026-01-01T00:00:00.000Z", runs: 2, lastOk: null,
  }
  const takeover = (steps: Step[], results: Partial<StepResult>[]) => appendPending(home, "default", "https://shop.example.com/cart", steps, res(results))

  it("a save for another task after a stopped replay is a new plan; the stopped plan is unchanged", () => {
    const file = savePlan(home, STORED)
    const before = readFileSync(file, "utf8")
    recordReplayStop(home, "default", "shop-example-com/add-an-item-and-ship", STORED, { batch: 0, step: 2 })
    takeover([{ action: "click", target: "Export orders" }], [{ action: "click", resolved: { role: "button", name: "Export orders" } }])
    const saved = savePending(home, "default", "export the orders")!
    expect(saved.updated).toBeUndefined()
    expect(saved.id).toBe("shop-example-com/export-the-orders")
    expect(saved.note).toBe("saved as a new plan; shop-example-com/add-an-item-and-ship unchanged")
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(listPlans(home)).toHaveLength(2)
  })

  it("a takeover that resends the stopped batch whole does not repeat its replayed steps", () => {
    savePlan(home, STORED)
    recordReplayStop(home, "default", "shop-example-com/add-an-item-and-ship", STORED, { batch: 0, step: 2 })
    takeover(
      [{ action: "click", target: "Add item" }, { action: "fill", target: "Full name", value: "Ada Lovelace" }, { action: "click", target: "Next" }],
      [
        { action: "click", resolved: { role: "button", name: "Add item" } },
        { resolved: { role: "textbox", name: "Full name" } },
        { action: "click", resolved: { role: "button", name: "Next" } },
      ],
    )
    const saved = savePending(home, "default", "add an item and ship")!
    expect(saved.updated).toBe(true)
    expect(saved.plan.batches).toEqual([STORED.batches[0]!.slice(0, 2), [{ action: "click", target: { text: "Next", role: "button" } }]])
    expect(saved.plan.params).toEqual([{ name: "full_name", secret: false }])
  })

  it("values passed as secrets are not hashed into the takeover journal", () => {
    recordReplayStop(home, "default", "x/y", STORED, { batch: 0, step: 0 }, { full_name: "Ada Lovelace" }, new Set(["full_name"]))
    expect(JSON.parse(readFileSync(pendingFile(), "utf8")).seen).toEqual([])
    recordReplayStop(home, "default", "x/y", STORED, { batch: 0, step: 0 }, { full_name: "Ada Lovelace" })
    expect(JSON.parse(readFileSync(pendingFile(), "utf8")).seen).toHaveLength(1)
  })
})
