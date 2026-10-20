import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  recorded: undefined as number | undefined,
  agentCalls: [] as string[],
  /** What Runtime.evaluate answers. */
  evaluated: { result: { type: "number", value: 3 } } as Record<string, unknown>,
  cdpSent: [] as { method: string; params: unknown }[],
}))

vi.mock("../background/recorder", async (importOriginal) => {
  const real = await importOriginal<typeof import("../background/recorder")>()
  return {
    ...real,
    ready: async () => {},
    assertNotRecorded: (id: number) => {
      if (state.recorded === id) throw new real.TabRecordedError(id)
    },
  }
})
vi.mock("../background/agent-bridge", () => ({
  isRestrictedUrl: () => false,
  callAgent: vi.fn(async (_tab: number, method: string) => {
    state.agentCalls.push(method)
    return 'textbox "Card number" value="4242 4242 4242 4242"'
  }),
}))
vi.mock("../background/capture", () => ({
  ensureCapturing: vi.fn(async () => {}),
  consoleEntries: vi.fn(() => [{ level: "log", text: "posted otp=918273" }]),
  networkEntries: vi.fn(() => [{ url: "https://bank.example/pay?card=4242" }]),
  screenshot: vi.fn(async () => ({ data: "" })),
}))
vi.mock("../background/activity", () => ({ ready: async () => {}, record: vi.fn(), list: vi.fn(() => []), errorSummary: () => "", resultSummary: () => "" }))
vi.mock("../background/control", () => ({
  ready: async () => {},
  assertNotPaused: () => {},
  onChange: () => {},
  pausedError: () => new Error("paused"),
}))
vi.mock("../background/serial", () => ({ rejectWaiters: () => {} }))
vi.mock("../background/cdp", () => ({
  ensureAttached: vi.fn(async () => {}),
  hold: () => () => {},
  send: vi.fn(async (_tab: number, method: string, params: unknown) => {
    state.cdpSent.push({ method, params })
    return state.evaluated
  }),
}))
vi.mock("../background/batch", () => ({ runBatch: vi.fn() }))
vi.mock("../background/pipeline", () => ({ goto: vi.fn(), runAction: vi.fn() }))
vi.mock("../background/cache", () => ({}))
vi.mock("../background/sessions", () => {
  const s = { name: "a", groupId: null, activeTabId: 5, tabs: new Set([5, 6]), opener: new Map(), adoptedAt: new Map() }
  return {
    loadSessions: async () => {},
    findSession: () => s,
    getOrCreateSession: () => s,
    emptySession: () => s,
    activeTab: (x: typeof s) => x.activeTabId,
  }
})

beforeEach(() => {
  state.recorded = undefined
  state.agentCalls = []
  state.evaluated = { result: { type: "number", value: 3 } }
  state.cdpSent = []
  ;(globalThis as { chrome?: unknown }).chrome = { tabs: { get: vi.fn(async (id: number) => ({ id, url: "https://a.example/" })) } }
})

const call = async (method: string, params: Record<string, unknown> = method === "page.eval" ? { expression: "1 + 2" } : {}) => {
  const { route } = await import("../background/rpc-router")
  return route({ id: 1, session: "a", method, params })
}

describe("route: the tab the user is recording (R13)", () => {
  for (const method of ["page.snapshot", "page.console", "page.network", "page.eval"]) {
    it(`refuses ${method} for the recorded tab, reading nothing from it`, async () => {
      state.recorded = 5
      const r = (await call(method)) as { error?: { message: string }; result?: unknown }
      expect(r.result).toBeUndefined()
      expect(r.error?.message).toContain("tab 5 is being recorded by the user")
      expect(state.agentCalls).toEqual([])
    })

    it(`answers ${method} for a tab that is not recorded`, async () => {
      state.recorded = 6
      const r = (await call(method)) as { error?: unknown; result?: unknown }
      expect(r.error).toBeUndefined()
      expect(r.result).toBeDefined()
    })
  }
})

describe("route: page.eval", () => {
  it("evaluates in the page, awaiting promises, and answers the JSON value; the activity log gets the expression", async () => {
    const activity = await import("../background/activity")
    ;(activity.record as any).mockClear()
    const r = (await call("page.eval", { expression: "document.title.length" })) as { result?: unknown }
    expect(r.result).toEqual({ value: 3 })
    expect(state.cdpSent).toEqual([
      { method: "Runtime.evaluate", params: { expression: "document.title.length", awaitPromise: true, returnByValue: true, timeout: 10_000 } },
    ])
    expect((activity.record as any).mock.calls[0][0]).toMatchObject({ method: "page.eval", target: "document.title.length", summary: "✓ ran a page script" })
  })

  it("a script that throws is the caller's error (BAD_REQUEST) with its first line", async () => {
    state.evaluated = { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: foo is not defined\n    at <anonymous>:1:1" } } }
    const r = (await call("page.eval", { expression: "foo" })) as { error?: { code: string; message: string } }
    expect(r.error).toEqual({ code: "BAD_REQUEST", message: "page script threw: ReferenceError: foo is not defined" })
  })

  it("answers {} for undefined, and refuses an empty expression", async () => {
    state.evaluated = { result: { type: "undefined" } }
    expect(((await call("page.eval", { expression: "void 0" })) as { result?: unknown }).result).toEqual({})
    expect(((await call("page.eval", { expression: "  " })) as { error?: { code: string } }).error?.code).toBe("BAD_REQUEST")
  })
})
