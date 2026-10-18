import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BatchResult, Step, StepResult } from "@kitestring/protocol"
import { buildPlan } from "../src/memory/build.js"
import { PENDING_MAX_STEPS, appendPending, discardPending, planFromPending, takePending } from "../src/memory/pending.js"

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
})
