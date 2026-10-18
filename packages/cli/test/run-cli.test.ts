import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BatchResult, Plan } from "@kitestring/protocol"
import { startDaemon, type Daemon } from "../src/host/daemon.js"
import { listPlans, savePlan } from "../src/memory/store.js"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js")
let dir: string
let daemon: Daemon | undefined
let received: any[]
let answers: unknown[]
let tabUrl: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kiterun-"))
  received = []
  answers = []
  tabUrl = "https://dash.example.com/items/1"
})
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  rmSync(dir, { recursive: true, force: true })
})

async function startFake(): Promise<void> {
  const d: Daemon = await startDaemon({
    socketPath: join(dir, "kite.sock"),
    toExtension: (msg: any) => {
      received.push(msg)
      const result =
        msg.method === "tab.list"
          ? { tabs: [{ id: 1, url: tabUrl, active: true }] }
          : (answers.shift() ?? { ok: true, steps: [], diff: { added: [], removed: [] }, page: "P" })
      queueMicrotask(() => d.fromExtension({ id: msg.id, result }))
    },
  })
  daemon = d
}

function kite(args: string[], input?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, KITE_SESSION: "", KITE_HOME: dir } })
    if (input !== undefined) p.stdin.end(input)
    let out = ""
    let err = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (err += d))
    p.on("close", (code) => resolve({ code, out, err }))
  })
}

const PLAN: Plan = {
  version: 1,
  intent: "publish store listing",
  origin: "https://dash.example.com",
  pathPattern: "/",
  params: [{ name: "title", secret: false }, { name: "password", secret: true }],
  batches: [
    [{ action: "fill", target: { text: "Title", role: "textbox" }, value: "{{title}}" }],
    [
      { action: "fill", target: { text: "Password", role: "textbox" }, value: "{{password}}" },
      { action: "click", target: { text: "Save", role: "button" } },
    ],
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  runs: 0,
  lastOk: null,
}
const ok = (n: number): BatchResult => ({
  ok: true,
  steps: Array.from({ length: n }, (_, i) => ({ i, action: "fill", status: "done" as const, ms: 1 })),
  diff: { added: [], removed: [] },
  page: "P",
})

describe("kite run", () => {
  it("missing params: exit 2 naming every one, before touching the browser", async () => {
    await startFake()
    savePlan(dir, PLAN)
    const r = await kite(["run", "publish-store-listing"])
    expect(r.code).toBe(2)
    expect(r.err).toContain("missing parameters: title, password")
    expect(received).toEqual([])
    const both = await kite(["run", "publish-store-listing", "--param", "titel=c"])
    expect(both.code).toBe(2)
    expect(both.err).toMatch(/unknown parameter: titel.*missing parameters: title, password/)
  })

  it("an unknown --param is an error (exit 2), not ignored", async () => {
    await startFake()
    savePlan(dir, PLAN)
    const r = await kite(["run", "publish-store-listing", "--param", "title=a", "--secret", "password=b", "--param", "titel=c"])
    expect(r.code).toBe(2)
    expect(r.err).toContain("titel")
    expect(received).toEqual([])
  })

  it("all ok: human line, runs bumped, exit 0", async () => {
    await startFake()
    savePlan(dir, PLAN)
    answers = [ok(1), ok(2)]
    const r = await kite(["run", "publish-store-listing", "--param", "title=My kite", "--secret", "password=hunter2"])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toMatch(/^ran plan publish-store-listing · 2 batches · \d+\.\d s · ✓$/m)
    expect(received.map((m) => m.method)).toEqual(["tab.list", "act.batch", "tab.list", "act.batch"])
    expect(received[1].session).toBe("default")
    expect(listPlans(dir)[0]!.plan.runs).toBe(1)
  })

  it("a risky halt exits 3 and says where it stopped", async () => {
    await startFake()
    savePlan(dir, PLAN)
    answers = [
      ok(1),
      { ...ok(2), ok: false, halted: { index: 1, reason: "risky", detail: 'click "Publish" looks irreversible' }, next: 1 },
    ]
    const r = await kite(["run", "publish-store-listing", "--param", "title=a", "--param", "password=b"])
    expect(r.code).toBe(3)
    expect(r.out).toContain('stopped at batch 2 step 2 (risky: "Save") — page left there, take over')
  })

  it("--dry-run prints filled batches with secrets as •••• and sends no act.*", async () => {
    await startFake()
    savePlan(dir, PLAN)
    const r = await kite(["run", "publish-store-listing", "--dry-run", "--param", "title=My kite", "--secret", "password=hunter2"])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain("My kite")
    expect(r.out).toContain("••••")
    expect(r.out).not.toContain("hunter2")
    expect(received.filter((m) => String(m.method).startsWith("act."))).toEqual([])
  })

  it("--json prints the replay result", async () => {
    await startFake()
    savePlan(dir, PLAN)
    answers = [ok(1), ok(2)]
    const r = await kite(["--json", "run", "publish-store-listing", "--param", "title=a", "--param", "password=b"])
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, batches: 2 })
  })

  it("the tab on another site: exit 1, wrong_page, nothing sent", async () => {
    await startFake()
    savePlan(dir, PLAN)
    tabUrl = "https://evil.example.net/"
    const r = await kite(["run", "publish-store-listing", "--param", "title=a", "--param", "password=b"])
    expect(r.code).toBe(1)
    expect(r.out).toContain("stopped at batch 1 step 1 (wrong_page")
    expect(received.filter((m) => String(m.method).startsWith("act."))).toEqual([])
  })

  it("memory find matches by intent", async () => {
    savePlan(dir, PLAN)
    const r = await kite(["memory", "find", "publish the store listing"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("dash-example-com/publish-store-listing")
    const none = await kite(["memory", "find", "delete my account", "--site", "https://dash.example.com"])
    expect(none.code).toBe(1)
    expect(none.out).toContain("no plan")
  })

  it("an unknown plan is exit 2", async () => {
    const r = await kite(["run", "nope"])
    expect(r.code).toBe(2)
    expect(r.err).toContain("no such plan")
  })
})

describe("kite batch -> kite memory save / discard", () => {
  const STEPS = [
    { action: "goto", url: "https://dash.example.com/items/new?token=abc123" },
    { action: "fill", target: "Title", value: "My secret kite" },
  ]
  const RES: BatchResult = {
    ok: true,
    steps: [
      { i: 0, action: "goto", status: "done", ms: 1 },
      { i: 1, action: "fill", status: "done", ms: 1, resolved: { role: "textbox", name: "Title" } },
    ],
    diff: { added: [], removed: [] },
    page: "P",
    startUrl: "about:blank",
  }

  it("an ok batch is journaled without values and saved as a plan", async () => {
    await startFake()
    answers = [RES]
    const b = await kite(["batch", "-"], JSON.stringify(STEPS))
    expect(b.code, b.err).toBe(0)
    expect(b.out).not.toContain("resolved")
    const pending = join(dir, "memory", ".pending", "default.json")
    const raw = readFileSync(pending, "utf8")
    expect(raw).not.toContain("My secret kite")
    expect(raw).not.toContain("abc123")
    const s = await kite(["memory", "save", "create a listing"])
    expect(s.code, s.err).toBe(0)
    expect(s.out).toContain("saved plan dash-example-com/create-a-listing")
    expect(existsSync(pending)).toBe(false)
    const [stored] = listPlans(dir)
    expect(stored!.plan).toMatchObject({ origin: "https://dash.example.com", pathPattern: "/items/new", params: [{ name: "title", secret: false }] })
    const nothing = await kite(["memory", "save", "again"])
    expect(nothing.code).toBe(2)
    expect(nothing.err).toContain("nothing to save")
  })

  it("discard drops the journal", async () => {
    await startFake()
    answers = [RES]
    await kite(["batch", "-"], JSON.stringify(STEPS))
    expect((await kite(["memory", "discard"])).out).toContain("discarded")
    expect(existsSync(join(dir, "memory", ".pending", "default.json"))).toBe(false)
    expect((await kite(["memory", "discard"])).out).toContain("nothing pending")
  })

  it("a batch memory cannot store still exits by the batch's own result, with a note on stderr", async () => {
    await startFake()
    answers = [{ ...RES, steps: [RES.steps[0], { ...RES.steps[1]!, resolved: { role: "", name: "My secret kite" } }] }]
    const b = await kite(["batch", "-"], JSON.stringify([STEPS[0], { action: "fill", target: "My secret kite", value: "My secret kite" }]))
    expect(b.code).toBe(0)
    expect(b.err).toMatch(/kite: not remembered: /)
  })

  it("--json batch output carries no startUrl", async () => {
    await startFake()
    answers = [{ ...RES, startUrl: "https://dash.example.com/?token=abc123" }]
    const b = await kite(["--json", "batch", "-"], JSON.stringify(STEPS))
    expect(b.out).not.toContain("startUrl")
    expect(b.out).not.toContain("abc123")
  })

  it("a run discards the journal; after a stopped run the takeover is saved into the same plan", async () => {
    await startFake()
    answers = [RES]
    await kite(["batch", "-"], JSON.stringify(STEPS)) // unrelated earlier work
    savePlan(dir, PLAN)
    answers = [ok(1), { ...ok(2), ok: false, steps: [ok(1).steps[0]!, { i: 1, action: "click", status: "not_found", ms: 1 }], halted: { index: 1, reason: "not_found" }, next: 1 }]
    const r = await kite(["run", "publish-store-listing", "--param", "title=a", "--param", "password=b"])
    expect(r.code).toBe(1)
    answers = [{ ...RES, steps: [{ i: 0, action: "click", status: "done", ms: 1, resolved: { role: "button", name: "Save changes" } }], startUrl: "https://dash.example.com/items/1" }]
    await kite(["batch", "-"], JSON.stringify([{ action: "click", target: "Save changes" }]))
    const s = await kite(["memory", "save", "publish store listing"])
    expect(s.code, s.err).toBe(0)
    expect(s.out).toContain("updated plan dash-example-com/publish-store-listing")
    const [stored] = listPlans(dir)
    expect(listPlans(dir)).toHaveLength(1)
    expect(stored!.plan.batches).toEqual([
      PLAN.batches[0],
      [PLAN.batches[1]![0]],
      [{ action: "click", target: { text: "Save changes", role: "button" } }],
    ])
    expect(JSON.stringify(stored!.plan)).not.toContain("create a listing")
  })
})
