import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActionResult, BatchParams, Step } from "@kitestring/protocol"

/** What runStep answers for each call, in order; default: done after `ms` (fake time). */
type Script = (call: { tabId: number; action: any; opts: any }) => Promise<any> | any

const state = vi.hoisted(() => ({
  paused: false,
  urls: new Map<number, string>(),
  snapshots: new Map<number, string>(),
  pageText: "",
  findResult: { kind: "found", ref: "@e00001", line: 'button "X" [@e00001]' } as any,
  script: [] as Script[],
  calls: [] as { tabId: number; action: any; opts: any }[],
}))

vi.mock("@kitestring/page-agent", () => ({
  diffSnapshots: (a: string, b: string) => {
    const A = a.split("\n").filter(Boolean)
    const B = b.split("\n").filter(Boolean)
    return { added: B.filter((l) => !A.includes(l)), removed: A.filter((l) => !B.includes(l)) }
  },
}))
vi.mock("../background/agent-bridge", () => ({
  isRestrictedUrl: () => false,
  callAgent: vi.fn(async (tabId: number, method: string, args: unknown[]) => {
    if (method === "snapshot") return state.snapshots.get(tabId) ?? ""
    if (method === "brief") return `brief of ${state.urls.get(tabId)}`
    if (method === "find") return state.findResult
    if (method === "hasText") return state.pageText.toLowerCase().includes(String(args[0]).toLowerCase())
    throw new Error(`unexpected agent call ${method}`)
  }),
}))
vi.mock("../background/control", async () => {
  const { RpcError } = await import("../background/errors")
  return {
    assertNotPaused: () => {
      if (state.paused) throw new RpcError("PAUSED", "PAUSED: Kitestring is paused by the user")
    },
  }
})
vi.mock("../background/sessions", () => ({
  activeTab: (s: any) => s.activeTabId,
  agentActing: vi.fn(() => () => {}),
  newestAdopted: vi.fn(() => undefined),
  openerOf: vi.fn(() => undefined),
  useTab: vi.fn(async (s: any, id: number) => {
    s.activeTabId = id
    return { id, url: state.urls.get(id), title: "" }
  }),
}))
vi.mock("../background/pipeline", () => ({
  runStep: vi.fn(async (_s: unknown, tabId: number, action: any, opts: any) => {
    const call = { tabId, action, opts }
    state.calls.push(call)
    const next = state.script.shift()
    return next ? next(call) : ok()
  }),
}))

function ok(extra: Partial<ActionResult> = {}): ActionResult & { resolved?: any; halt?: any } {
  return { ok: true, status: "done", diff: { added: [], removed: [] }, page: "P", acted: true, ...extra } as any
}
const after = (ms: number, res: any = ok()) => () => new Promise((r) => setTimeout(() => r(res), ms))

const session = () => ({
  name: "a",
  groupId: null,
  activeTabId: 1,
  tabs: new Set([1, 2]),
  opener: new Map(),
  adoptedAt: new Map(),
})
const click = (text: string, extra: Partial<Step> = {}): Step => ({ action: "click", target: { text }, ...extra }) as Step

async function run(params: BatchParams, s = session()) {
  const { runBatch } = await import("../background/batch")
  const record = vi.fn()
  const p = runBatch(s as any, params, { batchId: 7, record })
  return { p, record, s }
}

beforeEach(() => {
  vi.useFakeTimers()
  state.paused = false
  state.urls = new Map([
    [1, "https://www.shop.example/cart"],
    [2, "https://www.shop.example/other"],
  ])
  state.snapshots = new Map([[1, "heading \"Cart\""]])
  state.pageText = ""
  state.findResult = { kind: "found", ref: "@e00001", line: 'button "X" [@e00001]' }
  state.script = []
  state.calls = []
  ;(globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: state.urls.get(id) ?? "", title: `T${id}` })),
    },
  }
})
afterEach(() => vi.useRealTimers())

describe("runBatch", () => {
  it("three ok steps → ok:true with three step results and one activity entry each", async () => {
    const { p, record } = await run({ steps: [click("A"), click("B"), click("C")] })
    await vi.advanceTimersByTimeAsync(0)
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.steps.map((s: any) => [s.i, s.action, s.status])).toEqual([
      [0, "click", "done"],
      [1, "click", "done"],
      [2, "click", "done"],
    ])
    expect(r.halted).toBeUndefined()
    expect(r.next).toBeUndefined()
    expect(record).toHaveBeenCalledTimes(3)
    expect(record.mock.calls.map((c) => [c[0].method, c[0].batch, c[0].target])).toEqual([
      ["act.click", 7, '"A"'],
      ["act.click", 7, '"B"'],
      ["act.click", 7, '"C"'],
    ])
  })

  it("reports the start URL and which fields were secret (for the pending journal)", async () => {
    state.script = [
      () => ok({ resolved: { role: "textbox", name: "Password" }, secret: true } as any),
      () => ok({ resolved: { role: "button", name: "B" } } as any),
    ]
    const { p } = await run({ steps: [{ action: "fill", target: { text: "Password" }, value: "pw" } as Step, click("B")] })
    await vi.advanceTimersByTimeAsync(0)
    const r = await p
    expect(r.startUrl).toBe("https://www.shop.example/cart")
    expect(r.steps.map((s) => s.secret)).toEqual([true, undefined])
  })

  it("not_found on step 1 halts with next:1; step 2 never runs", async () => {
    state.script = [() => ok(), () => ok({ ok: false, status: "not_found", detail: 'no element matches "B"', acted: false } as any)]
    const { p } = await run({ steps: [click("A"), click("B"), click("C")] })
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.halted).toEqual({ index: 1, reason: "not_found", detail: 'no element matches "B"' })
    expect(r.next).toBe(1)
    expect(r.steps).toHaveLength(2)
    expect(state.calls).toHaveLength(2)
  })

  it("if_present with a missing target is skipped and the batch continues", async () => {
    state.findResult = { kind: "not_found" }
    const { p, record } = await run({ steps: [click("Maybe", { if_present: true }), { action: "press", key: "Enter" }] })
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.steps.map((s: any) => s.status)).toEqual(["skipped", "done"])
    expect(state.calls.map((c) => c.action.kind)).toEqual(["press"])
    expect(record).toHaveBeenCalledTimes(1)
  })

  it("no_effect does not halt", async () => {
    state.script = [() => ok({ ok: false, status: "no_effect", detail: "nothing changed on the page" })]
    const r = await (await run({ steps: [click("A"), click("B")] })).p
    expect(r.ok).toBe(true)
    expect(r.steps.map((s: any) => s.status)).toEqual(["no_effect", "done"])
  })

  it("clicks get a risk check; a risky halt from the step stops the batch", async () => {
    state.script = [
      ({ opts }) => {
        expect(opts.beforeAct({ ref: "@e1", line: "", role: "button", name: "Delete account" })).toBe("risky")
        expect(opts.beforeAct({ ref: "@e1", line: "", role: "button", name: "Save" })).toBeNull()
        return ok({ ok: false, status: "error", detail: 'refusing to click "Delete account" in a batch', halt: "risky", acted: false } as any)
      },
    ]
    const r = await (await run({ steps: [click("Delete account"), click("B")] })).p
    expect(r.halted).toMatchObject({ index: 0, reason: "risky" })
    expect(r.next).toBe(0) // the step sent no input
    expect(state.calls).toHaveLength(1)
  })

  it("fill steps get no risk check", async () => {
    await (await run({ steps: [{ action: "fill", target: { text: "Send to" }, value: "x" } as Step] })).p
    expect(state.calls[0]!.opts.beforeAct).toBeUndefined()
  })

  it("budget 5_000, steps of 2_500 each → halt time with next = first unstarted", async () => {
    state.script = [after(2_500), after(2_500), after(2_500)]
    const { p } = await run({ steps: [click("A"), click("B"), click("C")], budget_ms: 5_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    const r = await p
    expect(r.halted).toMatchObject({ index: 1, reason: "time" })
    expect(r.next).toBe(1)
    expect(r.steps).toHaveLength(1)
    expect(state.calls[0]!.opts.capMs).toBe(4_000) // min(15_000, remaining − 1_000)
  })

  it("an expired step reports timeout, halts time, next = its own index", async () => {
    state.script = [
      () => ok(),
      () => ok({ ok: false, status: "timeout", detail: "action did not finish within 14000 ms", halt: "time" } as any),
    ]
    const r = await (await run({ steps: [click("A"), click("B"), click("C")] })).p
    expect(r.steps[1]).toMatchObject({ status: "timeout" })
    expect(r.halted).toMatchObject({ index: 1, reason: "time" })
    expect(r.next).toBe(1)
  })

  it("a page-not-ready timeout halts timeout with next = index + 1", async () => {
    state.script = [() => ok({ ok: false, status: "timeout", detail: "page not ready after 10000 ms" })]
    const r = await (await run({ steps: [click("A"), click("B")] })).p
    expect(r.halted).toMatchObject({ index: 0, reason: "timeout" })
    expect(r.next).toBe(1)
  })

  it("pause flipped during the first step → halt paused before the second", async () => {
    state.script = [
      () => {
        state.paused = true
        return ok()
      },
    ]
    const r = await (await run({ steps: [click("A"), click("B"), click("C")] })).p
    expect(r.halted).toMatchObject({ index: 1, reason: "paused" })
    expect(r.next).toBe(1)
    expect(r.steps).toHaveLength(1)
    expect(state.calls).toHaveLength(1)
  })

  it("lock held by another holder until the budget runs out → halted index 0 time, nothing run", async () => {
    const { withTabLock } = await import("../background/serial")
    let release!: () => void
    const holder = withTabLock(1, () => new Promise<void>((r) => (release = r)))
    const { p } = await run({ steps: [click("A")], budget_ms: 5_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.halted).toMatchObject({ index: 0, reason: "time" })
    expect(r.next).toBe(0)
    expect(r.steps).toEqual([])
    expect(state.calls).toHaveLength(0)
    release()
    await holder
  })

  it("a huge page diff is capped at 40 lines each side and the result stays under 900 KB", async () => {
    const lines = (p: string) => Array.from({ length: 200 }, (_, i) => `${p} ${i} ${"x".repeat(3_000)}`).join("\n")
    state.snapshots.set(1, lines("old"))
    state.script = [
      () => {
        state.snapshots.set(1, lines("new"))
        return ok()
      },
    ]
    const r = await (await run({ steps: [click("A")] })).p
    expect(r.diff.added.length).toBeLessThanOrEqual(40)
    expect(r.diff.removed.length).toBeLessThanOrEqual(40)
    expect(r.diff.added.length).toBeGreaterThan(0)
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(900_000)
  })

  it("an oversized result drops diff lines first, then shortens the page brief", async () => {
    const big = (p: string) => Array.from({ length: 50 }, (_, i) => `${p} ${i} ${"y".repeat(30_000)}`).join("\n")
    state.snapshots.set(1, big("old"))
    state.script = [
      () => {
        state.snapshots.set(1, big("new"))
        return ok()
      },
    ]
    const r = await (await run({ steps: [click("A")] })).p
    const size = new TextEncoder().encode(JSON.stringify(r)).length
    expect(size).toBeLessThanOrEqual(900_000)
    expect(r.diff.added.length).toBeLessThan(40)
  })

  it("landing on another registrable domain halts domain", async () => {
    state.script = [
      () => {
        state.urls.set(1, "https://evil.example.net/")
        return ok({ navigation: { url: "https://evil.example.net/", title: "" } })
      },
    ]
    const r = await (await run({ steps: [click("A"), click("B")] })).p
    expect(r.halted).toMatchObject({ index: 0, reason: "domain" })
    expect(r.halted!.detail).toContain("example.net")
    expect(r.next).toBe(1)
  })

  it("a subdomain of the same registrable domain continues; allow_domains and goto domains are accepted", async () => {
    state.script = [
      () => {
        state.urls.set(1, "https://accounts.shop.example/login")
        return ok()
      },
      () => {
        state.urls.set(1, "https://id.partner.io/")
        return ok()
      },
      () => {
        state.urls.set(1, "https://docs.elsewhere.org/a")
        return ok()
      },
    ]
    const r = await (
      await run({
        steps: [click("A"), click("B"), { action: "goto", url: "https://elsewhere.org/" } as Step],
        allow_domains: ["partner.io"],
      })
    ).p
    expect(r.ok).toBe(true)
  })

  it("about:blank is never a domain halt", async () => {
    state.script = [
      () => {
        state.urls.set(1, "about:blank")
        return ok()
      },
    ]
    expect((await (await run({ steps: [click("A")] })).p).ok).toBe(true)
  })

  it("a confirm the step had no policy for halts dialog; alerts do not", async () => {
    const alert = { type: "alert" as const, message: "Hello", handled: "accepted" as const }
    const confirm = { type: "confirm" as const, message: "Really?", handled: "dismissed" as const }
    state.script = [() => ok({ dialogs: [alert] }), () => ok({ dialogs: [confirm] })]
    const r = await (await run({ steps: [click("A"), click("B"), click("C")] })).p
    expect(r.halted).toMatchObject({ index: 1, reason: "dialog" })
    expect(r.halted!.detail).toContain("Really?")
    expect(r.halted!.detail).toContain('resend this step with dialog: "accept" to confirm')
    expect(r.next).toBe(1) // the dismissed dialog cancelled the step's effect
    expect(r.dialogs).toEqual([alert, confirm])
  })

  it("a step with a dialog policy passes it on and does not halt", async () => {
    state.script = [
      ({ opts }) => {
        expect(opts.dialog).toBe("accept")
        return ok({ dialogs: [{ type: "confirm", message: "Sure?", handled: "accepted" }] })
      },
    ]
    expect((await (await run({ steps: [click("A", { dialog: "accept" })] })).p).ok).toBe(true)
  })

  it("expect text / url: a miss halts expect", async () => {
    state.pageText = "Order Confirmed"
    const r1 = await (await run({ steps: [click("A", { expect: { text: "order confirmed" } })] })).p
    expect(r1.ok).toBe(true)
    const r2 = await (await run({ steps: [click("A", { expect: { url: "/^https:\\/\\/www\\.shop\\.example\\/cart$/" } })] })).p
    expect(r2.ok).toBe(true)
    const r3 = await (await run({ steps: [click("A", { expect: { text: "Thank you" } }), click("B")] })).p
    expect(r3.halted).toMatchObject({ index: 0, reason: "expect" })
    expect(r3.next).toBe(1)
  })

  it("step wait polls find until the target appears", async () => {
    let n = 0
    const { callAgent } = await import("../background/agent-bridge")
    const original = (callAgent as any).getMockImplementation()
    ;(callAgent as any).mockImplementation(async (tabId: number, method: string) => {
      if (method === "find") return ++n < 4 ? { kind: "not_found" } : { kind: "found", ref: "@e1", line: "" }
      if (method === "snapshot") return state.snapshots.get(tabId) ?? ""
      return ""
    })
    const { p } = await run({ steps: [click("Later", { wait: 5_000 })] })
    await vi.advanceTimersByTimeAsync(1_000)
    const r = await p
    ;(callAgent as any).mockImplementation(original)
    expect(n).toBe(4)
    expect(r.ok).toBe(true)
    expect(state.calls).toHaveLength(1)
  })

  it("switch_tab new moves the batch to the newest adopted tab and makes it active", async () => {
    const sessions = await import("../background/sessions")
    ;(sessions.newestAdopted as any).mockReturnValue(2)
    const { p, s } = await run({ steps: [click("Open"), { action: "switch_tab", to: "new" } as Step, click("Confirm")] })
    const r = await p
    expect(r.ok).toBe(true)
    expect(state.calls.map((c) => c.tabId)).toEqual([1, 2])
    expect(s.activeTabId).toBe(2)
  })

  it("a step that closes its own tab hands the batch to its opener, even before forget() ran", async () => {
    const { openerOf } = await import("../background/sessions")
    vi.mocked(openerOf).mockReturnValueOnce(2) // captured before the step; s.tabs still holds tab 1 afterwards
    state.script.push(() => ok({ detail: "the tab closed itself" } as any))
    const { p, s } = await run({ steps: [click("Allow"), click("Next")] })
    const r = await p
    expect(r.ok).toBe(true)
    expect(state.calls.map((c) => c.tabId)).toEqual([1, 2])
    expect(s.activeTabId).toBe(2)
  })

  it("a step that closes its tab with no known opener halts error before the next step", async () => {
    state.script.push(() => ok({ detail: "the tab closed itself" } as any))
    const r = await (await run({ steps: [click("Allow"), click("Next")] })).p
    expect(r.halted).toMatchObject({ index: 0, reason: "error", detail: "tab 1 closed" })
    expect(r.next).toBe(1)
    expect(state.calls).toHaveLength(1)
  })

  it("switch_tab opener whose opener closed halts error", async () => {
    const sessions = await import("../background/sessions")
    ;(sessions.openerOf as any).mockReturnValue(99)
    const r = await (await run({ steps: [{ action: "switch_tab", to: "opener" } as Step] })).p
    expect(r.halted).toMatchObject({ index: 0, reason: "error" })
    expect(r.halted!.detail).toContain("99")
    expect(r.next).toBe(0) // still on the old tab: resending must start with the switch
  })

  it("switch_tab to a tab the session does not own halts error with next at the switch", async () => {
    const r = await (await run({ steps: [{ action: "switch_tab", to: 5 } as Step, click("A")] })).p
    expect(r.halted).toMatchObject({ index: 0, reason: "error" })
    expect(r.next).toBe(0)
    expect(state.calls).toHaveLength(0)
  })

  it("an error before any input (navigation failed) halts with next at the step", async () => {
    state.script = [
      () => ok(),
      () => ok({ ok: false, status: "error", detail: "navigation failed: net::ERR_NAME_NOT_RESOLVED", acted: false } as any),
    ]
    const r = await (await run({ steps: [click("A"), { action: "goto", url: "https://nope.invalid/" } as Step, click("B")] })).p
    expect(r.halted).toMatchObject({ index: 1, reason: "error" })
    expect(r.next).toBe(1)
  })

  it("an error after the input went out (value mismatch) halts with next after the step", async () => {
    state.script = [() => ok({ ok: false, status: "error", detail: "value mismatch", acted: true } as any)]
    const r = await (await run({ steps: [{ action: "fill", target: { text: "Name" }, value: "x" } as Step, click("B")] })).p
    expect(r.halted).toMatchObject({ index: 0, reason: "error" })
    expect(r.next).toBe(1)
  })

  it("a bad key (BAD_REQUEST thrown before input) halts error with next at the step", async () => {
    const { RpcError } = await import("../background/errors")
    state.script = [
      () => ok(),
      () => {
        throw new RpcError("BAD_REQUEST", 'BAD_REQUEST: unknown key "Foo"')
      },
    ]
    const r = await (await run({ steps: [click("A"), { action: "press", key: "Foo" } as Step] })).p
    expect(r.halted).toMatchObject({ index: 1, reason: "error" })
    expect(r.halted!.detail).toContain("unknown key")
    expect(r.next).toBe(1)
  })

  it("after switch_tab the old tab's lock is free while the batch goes on", async () => {
    const sessions = await import("../background/sessions")
    ;(sessions.newestAdopted as any).mockReturnValue(2)
    const { withTabLock } = await import("../background/serial")
    let oldTabFree = false
    state.script = [
      () => ok(),
      async () => {
        // Runs on tab 2 while the batch still holds that lock: tab 1 must be takeable now.
        await withTabLock(1, async () => {
          oldTabFree = true
        })
        return ok()
      },
    ]
    const { p } = await run({ steps: [click("Open"), { action: "switch_tab", to: "new" } as Step, click("Confirm")] })
    await vi.advanceTimersByTimeAsync(0)
    const r = await p
    expect(r.ok).toBe(true)
    expect(oldTabFree).toBe(true)
  })

  it("once runBatch has answered, the final tab's lock is free", async () => {
    const sessions = await import("../background/sessions")
    ;(sessions.newestAdopted as any).mockReturnValue(2)
    const r = await (await run({ steps: [{ action: "switch_tab", to: "new" } as Step, click("Confirm")] })).p
    expect(r.ok).toBe(true)
    const { withTabLock } = await import("../background/serial")
    let ran = false
    const next = withTabLock(2, async () => {
      ran = true
    })
    await vi.advanceTimersByTimeAsync(0)
    await next
    expect(ran).toBe(true)
  })

  it("upload steps record base names only", async () => {
    const { p, record } = await run({
      steps: [{ action: "upload", target: { text: "Avatar" }, files: ["/Users/me/secret/dir/a.png"] } as Step],
    })
    await p
    expect(record.mock.calls[0]![0].target).toBe('"Avatar" ← a.png')
    expect(JSON.stringify(record.mock.calls)).not.toContain("/Users/me")
  })

  it("a step's dialogs go into its activity entry", async () => {
    const confirm = { type: "confirm" as const, message: "Sure?", handled: "accepted" as const }
    state.script = [() => ok(), () => ok({ dialogs: [confirm] })]
    const { p, record } = await run({ steps: [click("A"), click("B", { dialog: "accept" })] })
    await p
    expect(record.mock.calls[0]![0].dialogs).toBeUndefined()
    expect(record.mock.calls[1]![0].dialogs).toEqual([confirm])
  })

  it("marks every tab it works on as agent-active until the batch ends (tab adoption)", async () => {
    const sessions = await import("../background/sessions")
    ;(sessions.newestAdopted as any).mockReturnValue(2)
    const ended: number[] = []
    ;(sessions.agentActing as any).mockClear()
    ;(sessions.agentActing as any).mockImplementation((id: number) => () => ended.push(id))
    const { p } = await run({ steps: [click("Open"), { action: "switch_tab", to: "new" } as Step, click("Confirm")] })
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect((sessions.agentActing as any).mock.calls.map((c: number[]) => c[0])).toEqual([1, 2])
    expect(ended.sort()).toEqual([1, 2])
    ;(sessions.newestAdopted as any).mockReturnValue(undefined)
    ;(sessions.agentActing as any).mockImplementation(() => () => {})
  })
})
