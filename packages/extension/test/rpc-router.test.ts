import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ recorded: undefined as number | undefined, agentCalls: [] as string[] }))

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
vi.mock("../background/activity", () => ({ ready: async () => {}, record: vi.fn(), list: vi.fn(() => []) }))
vi.mock("../background/control", () => ({
  ready: async () => {},
  assertNotPaused: () => {},
  onChange: () => {},
  pausedError: () => new Error("paused"),
}))
vi.mock("../background/serial", () => ({ rejectWaiters: () => {} }))
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
})

const call = async (method: string, params: Record<string, unknown> = {}) => {
  const { route } = await import("../background/rpc-router")
  return route({ id: 1, session: "a", method, params })
}

describe("route: the tab the user is recording (R13)", () => {
  for (const method of ["page.snapshot", "page.console", "page.network"]) {
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
