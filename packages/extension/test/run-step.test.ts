import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const FOUND = {
  kind: "found",
  ref: "@e00001",
  line: 'button "Delete everything" [@e00001]',
  role: "button",
  name: "Delete everything",
  within: "Danger zone",
}
const agent = vi.hoisted(() => ({
  /** Overrides for single agent methods (reset after each test). */
  extra: {} as Record<string, (args: unknown[]) => unknown>,
  find: (): unknown => ({
    kind: "found",
    ref: "@e00001",
    line: 'button "Delete everything" [@e00001]',
    role: "button",
    name: "Delete everything",
    within: "Danger zone",
  }),
}))

vi.mock("@kitestring/page-agent", () => ({ diffSnapshots: () => ({ added: ["x"], removed: [] }) }))
vi.mock("../background/agent-bridge", () => ({
  isRestrictedUrl: () => false,
  callAgent: vi.fn(async (_tabId: number, method: string, args: unknown[]) => {
    if (agent.extra[method]) return agent.extra[method]!(args)
    switch (method) {
      case "find":
        return agent.find()
      case "check":
        return { kind: "ok", x: 10, y: 20 }
      case "waitQuiet":
        return { quiet: true, waitedMs: 0 }
      default:
        return ""
    }
  }),
}))
vi.mock("../background/cdp", () => ({
  ensureAttached: vi.fn(async () => {}),
  isNotAttached: () => false,
  onEvent: vi.fn(() => () => {}),
  onAttach: vi.fn(),
  send: vi.fn(async (_tabId: number, method: string) =>
    method === "Page.getFrameTree" ? { frameTree: { frame: { id: "F" } } } : { result: {} },
  ),
}))
vi.mock("../background/input", () => ({ click: vi.fn(async () => {}), keyDef: vi.fn() }))
vi.mock("../background/network-idle", () => ({ trackNetwork: () => ({ stop() {}, waitIdle: async () => true }) }))
vi.mock("../background/sessions", () => ({ activeTab: vi.fn(), agentActing: vi.fn(() => () => {}) }))
vi.mock("../background/control", () => ({ assertNotPaused: vi.fn() }))

const s = { name: "a", groupId: null, activeTabId: 1, tabs: new Set([1]), opener: new Map(), adoptedAt: new Map() }

beforeEach(() => {
  ;(globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: "https://a.example/", title: "A" })),
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  }
})
afterEach(() => {
  agent.extra = {}
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("runStep", () => {
  it("beforeAct halting: no input dispatched, halt and resolved target reported", async () => {
    const { runStep } = await import("../background/pipeline")
    const input = await import("../background/input")
    const seen: unknown[] = []
    const r = await runStep(s, 1, { kind: "click", target: { text: "Delete everything" } }, {
      capMs: 15_000,
      beforeAct: (f) => {
        seen.push(f)
        return "risky"
      },
    })
    expect(seen).toEqual([{ ref: "@e00001", line: 'button "Delete everything" [@e00001]', role: "button", name: "Delete everything" }])
    expect(input.click).not.toHaveBeenCalled()
    expect(r.halt).toBe("risky")
    expect(r.acted).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.resolved).toEqual({ role: "button", name: "Delete everything", within: "Danger zone" })
  })

  it("beforeAct passing: the click goes through", async () => {
    const { runStep } = await import("../background/pipeline")
    const input = await import("../background/input")
    const r = await runStep(s, 1, { kind: "click", target: { text: "Delete everything" } }, { capMs: 15_000, beforeAct: () => null })
    expect(input.click).toHaveBeenCalledWith(1, 10, 20)
    expect(r.status).toBe("done")
    expect(r.acted).toBe(true)
    expect(r.halt).toBeUndefined()
  })

  it("a goto whose navigation fails did not act", async () => {
    const { runStep } = await import("../background/pipeline")
    const cdp = await import("../background/cdp")
    ;(cdp.send as any).mockImplementation(async (_t: number, method: string) =>
      method === "Page.getFrameTree" ? { frameTree: { frame: { id: "F" } } } : method === "Page.navigate" ? { errorText: "net::ERR_NAME_NOT_RESOLVED" } : { result: {} },
    )
    const r = await runStep(s, 1, { kind: "goto", url: "https://nope.invalid/" }, { capMs: 15_000 })
    expect(r).toMatchObject({ status: "error", detail: "navigation failed: net::ERR_NAME_NOT_RESOLVED", acted: false })
  })

  it("does not take the tab lock (the batch holds it)", async () => {
    const { runStep } = await import("../background/pipeline")
    const { withTabLock } = await import("../background/serial")
    let release!: () => void
    const held = withTabLock(1, () => new Promise<void>((r) => (release = r)))
    const r = await runStep(s, 1, { kind: "click", target: { text: "Delete everything" } }, { capMs: 15_000 })
    expect(r.status).toBe("done")
    release()
    await held
  })

  it("a step past its cap answers timeout with halt time, and reports when it really ended", async () => {
    vi.useFakeTimers()
    agent.find = () => new Promise(() => {})
    const { runStep } = await import("../background/pipeline")
    let tail: Promise<unknown> | undefined
    const p = runStep(s, 1, { kind: "click", target: { text: "X" } }, { capMs: 2_000, linger: (t) => (tail = t) })
    await vi.advanceTimersByTimeAsync(2_000)
    const r = await p
    expect(r).toMatchObject({ status: "timeout", halt: "time", detail: "action did not finish within 2000 ms" })
    expect(tail).toBeDefined()
    let ended = false
    void tail!.then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(4_900)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(ended).toBe(true)
  })

  it("a popup closed on the way is reported even when the step then fails (disabled)", async () => {
    agent.find = () => FOUND
    const checks = [
      { kind: "blocked", by: 'dialog "Cookies"' },
      { kind: "ok", x: 1, y: 2 },
      { kind: "disabled", errors: [] },
    ]
    agent.extra.check = () => checks.shift()
    agent.extra.closerFor = () => ({ ref: "@e00009", line: 'button "Reject all" [@e00009]', kind: "cookie" })
    const { runStep } = await import("../background/pipeline")
    const r = await runStep(s, 1, { kind: "click", target: { text: "Delete everything" } }, { capMs: 15_000 })
    expect(r).toMatchObject({ status: "disabled", acted: false, closedPopups: ['cookie "Reject all"'] })
  })

  it("an error thrown after the input went out is an error outcome that acted", async () => {
    agent.find = () => FOUND
    const input = await import("../background/input")
    ;(input.click as any).mockRejectedValueOnce(new Error("Target closed"))
    const { runStep } = await import("../background/pipeline")
    const r = await runStep(s, 1, { kind: "click", target: { text: "Delete everything" } }, { capMs: 15_000 })
    expect(r).toMatchObject({ ok: false, status: "error", detail: "Target closed", halt: "error", acted: true })
  })

  it("an error thrown before any input still throws (the batch classifies it)", async () => {
    agent.find = () => {
      throw new Error("agent gone")
    }
    const { runStep } = await import("../background/pipeline")
    await expect(runStep(s, 1, { kind: "click", target: { text: "X" } }, { capMs: 15_000 })).rejects.toThrow("agent gone")
  })
})
