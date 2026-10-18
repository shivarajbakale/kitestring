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
vi.mock("../background/input", () => ({ click: vi.fn(async () => {}), press: vi.fn(async () => {}), keyDef: vi.fn() }))
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
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  }
})
afterEach(() => {
  agent.extra = {}
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("runStep action cache", () => {
  const LOC = { ref: "@e00001", role: "button", name: "Delete everything", landmarkPath: ["main"], cssPath: "#d", nth: 0 }
  const key = (text: string) => ["https://a.example", "/", text, "", ""].join("\n")

  it("remembers what FIND resolved and hands it back as a hint; a hinted find reports cached", async () => {
    vi.resetModules() // a fresh, empty action cache (and a pipeline that uses it)
    const cache = await import("../background/cache")
    const { runStep } = await import("../background/pipeline")
    const hints: unknown[] = []
    agent.extra.find = (args) => {
      hints.push(args[2])
      return { ...FOUND, locator: LOC, hinted: args[2] !== undefined }
    }
    const first = await runStep(s, 1, { kind: "click", target: { text: "Delete everything" } }, { capMs: 15_000 })
    expect(first.cached).toBeUndefined()
    expect(cache.getHint(key("delete everything"))).toEqual(LOC)
    const second = await runStep(s, 1, { kind: "click", target: { text: "Delete everything" } }, { capMs: 15_000 })
    expect(hints).toEqual([undefined, LOC])
    expect(second.cached).toBe(true)
    // a cache-served step still reports what it resolved, so a stored plan never needs the @ref
    expect(second.resolved).toEqual({ role: "button", name: "Delete everything", within: "Danger zone" })
  })

  it("also remembers the element under its resolved name, so a stored plan's replay is served from the cache", async () => {
    vi.resetModules() // a fresh, empty action cache (and a pipeline that uses it)
    const cache = await import("../background/cache")
    const { runStep } = await import("../background/pipeline")
    agent.extra.find = () => ({ ...FOUND, locator: LOC, hinted: false })
    await runStep(s, 1, { kind: "click", target: { text: "delete" } }, { capMs: 15_000 })
    expect(cache.getHint(key("delete"))).toEqual(LOC)
    expect(cache.getHint(["https://a.example", "/", "delete everything", "button", "danger zone"].join("\n"))).toEqual(LOC)
  })

  it("a rejected hint is overwritten by the fresh find", async () => {
    vi.resetModules() // a fresh, empty action cache (and a pipeline that uses it)
    const cache = await import("../background/cache")
    cache.remember(key("delete everything"), { ...LOC, ref: "@estale", role: "link" })
    const { runStep } = await import("../background/pipeline")
    agent.extra.find = () => ({ ...FOUND, locator: LOC, hinted: false })
    const r = await runStep(s, 1, { kind: "click", target: { text: "Delete everything" } }, { capMs: 15_000 })
    expect(r.cached).toBeUndefined()
    expect(cache.getHint(key("delete everything"))).toEqual(LOC)
  })

  it("reports a secret field as secret (and a plain one not)", async () => {
    vi.resetModules() // a fresh, empty action cache (and a pipeline that uses it)
    const cache = await import("../background/cache")
    const { runStep } = await import("../background/pipeline")
    agent.extra.find = () => ({ ...FOUND, role: "textbox", hinted: false, secret: true })
    // (a click: this file's input mock has no typing; the flag comes from FIND either way)
    const pw = await runStep(s, 1, { kind: "click", target: { text: "Password" } }, { capMs: 15_000 })
    expect(pw.status).toBe("done")
    expect(pw.secret).toBe(true)
    agent.extra.find = () => ({ ...FOUND, hinted: false })
    const plain = await runStep(s, 1, { kind: "click", target: { text: "Delete everything" } }, { capMs: 15_000 })
    expect(plain.secret).toBeUndefined()
  })

  it("never caches an option-like choice (option, menuitemradio, treeitem, gridcell): its text is data", async () => {
    vi.resetModules() // a fresh, empty action cache (and a pipeline that uses it)
    const cache = await import("../background/cache")
    const { runStep } = await import("../background/pipeline")
    for (const role of ["option", "menuitemradio", "treeitem", "gridcell"]) {
      agent.extra.find = () => ({ ...FOUND, role, name: "Ada Lovelace", locator: { ...LOC, role, name: "Ada Lovelace" }, hinted: false })
      const r = await runStep(s, 1, { kind: "click", target: { text: "Ada Lovelace" } }, { capMs: 15_000 })
      expect(r.status).toBe("done")
    }
    expect(cache.stats().entries).toBe(0)
  })

  it("never caches (nor looks up) a target filled from a plan param (nocache)", async () => {
    vi.resetModules() // a fresh, empty action cache (and a pipeline that uses it)
    const cache = await import("../background/cache")
    cache.remember(key("ada lovelace"), LOC)
    const { runStep } = await import("../background/pipeline")
    const hints: unknown[] = []
    agent.extra.find = (args) => {
      hints.push(args[2])
      return { ...FOUND, name: "Ada Lovelace", locator: LOC, hinted: false }
    }
    const r = await runStep(s, 1, { kind: "click", target: { text: "Ada Lovelace" }, nocache: true }, { capMs: 15_000 })
    expect(r.status).toBe("done")
    expect(hints).toEqual([undefined])
    expect(cache.stats().entries).toBe(1) // only the entry put there above; nothing new under the resolved name
  })

  it("never caches a secret field or a ref target", async () => {
    vi.resetModules() // a fresh, empty action cache (and a pipeline that uses it)
    const cache = await import("../background/cache")
    const { runStep } = await import("../background/pipeline")
    agent.extra.find = () => ({ ...FOUND, role: "textbox", locator: LOC, hinted: false, secret: true })
    await runStep(s, 1, { kind: "fill", target: { text: "Password" }, value: "hunter2" }, { capMs: 15_000 })
    agent.extra.find = () => ({ ...FOUND, locator: LOC, hinted: false })
    await runStep(s, 1, { kind: "click", target: { ref: "@e00001" } }, { capMs: 15_000 })
    expect(cache.stats().entries).toBe(0)
  })
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

  it("a press with beforeAct checks what Enter would submit; a risky refusal sends no key", async () => {
    const { runStep } = await import("../background/pipeline")
    const input = await import("../background/input")
    const submit = { ref: "@e00002", line: 'button "Place order" [@e00002]', role: "button", name: "Place order" }
    agent.extra.enterSubmit = () => submit
    const seen: unknown[] = []
    const r = await runStep(s, 1, { kind: "press", key: "Enter" }, {
      capMs: 15_000,
      beforeAct: (f) => {
        seen.push(f)
        return "risky"
      },
    })
    expect(seen).toEqual([submit])
    expect(input.press).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: false, halt: "risky", acted: false })
    expect(r.detail).toContain('Enter would submit "Place order"')
  })

  it("a press outside any form (or with no beforeAct) goes through", async () => {
    const { runStep } = await import("../background/pipeline")
    const input = await import("../background/input")
    agent.extra.enterSubmit = () => null
    const r = await runStep(s, 1, { kind: "press", key: "Enter" }, { capMs: 15_000, beforeAct: () => "risky" })
    expect(input.press).toHaveBeenCalledWith(1, "Enter")
    expect(r.halt).toBeUndefined()
    expect(r.acted).toBe(true)
  })

  it("a select reports the chosen option's visible text (for stored plans' echo checks)", async () => {
    const { runStep } = await import("../background/pipeline")
    agent.extra.find = () => ({ ...FOUND, role: "combobox", name: "Country" })
    agent.extra.setSelect = () => "India"
    const r = await runStep(s, 1, { kind: "select", target: { text: "Country" }, value: "IN" }, { capMs: 15_000 })
    expect(r.status).toBe("done")
    expect(r.chosen).toBe("India")
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
