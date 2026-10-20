import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  url: "https://a.example/",
  /** Answers for the page agent's waitFor, in order (an Error is thrown); then the last one repeats. */
  agent: [] as unknown[],
  agentArgs: [] as unknown[][],
  /** Answers for Runtime.evaluate, in order (an Error rejects). */
  evals: [] as unknown[],
}))
const next = (list: unknown[]) => (list.length > 1 ? list.shift() : list[0])

vi.mock("../background/agent-bridge", () => ({
  callAgent: vi.fn(async (_t: number, method: string, args: unknown[]) => {
    if (method === "waitQuiet") return { quiet: true }
    state.agentArgs.push(args)
    const r = next(state.agent)
    if (r instanceof Error) throw r
    return r
  }),
}))
vi.mock("../background/cdp", () => ({
  ensureAttached: vi.fn(async () => {}),
  hold: () => () => {},
  send: vi.fn(async () => {
    const r = next(state.evals)
    if (r instanceof Error) throw r
    return r
  }),
}))
vi.mock("../background/network-idle", () => ({ trackNetwork: () => ({ waitIdle: async () => true, sent: () => 0, stop() {} }) }))

beforeEach(() => {
  state.url = "https://a.example/"
  state.agent = []
  state.agentArgs = []
  state.evals = []
  ;(globalThis as { chrome?: unknown }).chrome = { tabs: { get: vi.fn(async () => ({ url: state.url })) } }
})

const wait = async (cond: unknown, ms = 2_000) => {
  const { parseCondition, waitInTab } = await import("../background/wait")
  return waitInTab(1, parseCondition(cond), ms)
}

describe("parseCondition", () => {
  it("takes exactly one kind of condition", async () => {
    const { parseCondition } = await import("../background/wait")
    expect(() => parseCondition({})).toThrow(/exactly one of/)
    expect(() => parseCondition({ text: "a", url: "b" })).toThrow(/exactly one of .*got text, url/)
    expect(() => parseCondition({ selector: "a", state: "gone" })).toThrow(/state must be/)
    expect(() => parseCondition({ count: { selector: "a" } })).toThrow(/count must be/)
  })
  it("parses a text target with its scope, and defaults a selector to visible", async () => {
    const { parseCondition } = await import("../background/wait")
    expect(parseCondition({ target: "Latest", within: "Timeline", role: "tab" })).toEqual({ target: { text: "Latest", within: "Timeline", role: "tab" } })
    expect(parseCondition({ selector: "article" })).toEqual({ selector: "article", state: "visible" })
  })
})

describe("waitInTab", () => {
  it("url: polls the tab until it matches; a timeout says where the page is", async () => {
    setTimeout(() => (state.url = "https://a.example/search?q=x"), 150)
    expect((await wait({ url: "/search" })).ms).toBeGreaterThanOrEqual(100)
    state.url = "https://a.example/home"
    await expect(wait({ url: "/never" }, 150)).rejects.toThrow(/^TIMEOUT: waited 150 ms for the URL to match "\/never": the page is at https:\/\/a\.example\/home$/)
  })

  it("agent conditions: a navigation mid-wait (the agent goes away) carries on in the next document", async () => {
    state.agent = [new Error("Could not establish connection. Receiving end does not exist."), { ok: true }]
    expect(await wait({ selector: "article" })).toMatchObject({ ms: expect.any(Number) })
    expect(state.agentArgs).toHaveLength(2)
  })

  it("agent conditions: a timeout names what was last seen", async () => {
    state.agent = [{ ok: false, seen: '3 of 5 "article"' }]
    await expect(wait({ count: { selector: "article", min: 5 } }, 50)).rejects.toThrow('TIMEOUT: waited 50 ms for 5 "article": 3 of 5 "article"')
  })

  it("a bad selector is the caller's mistake, reported at once", async () => {
    state.agent = [new Error("Failed to execute 'querySelector' on 'Document': '[[' is not a valid selector.")]
    await expect(wait({ selector: "[[" })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(state.agentArgs).toHaveLength(1)
  })

  it("fn: returns the function's value, riding out a navigation", async () => {
    state.evals = [new Error("Execution context was destroyed."), { result: { value: { ok: true, value: { n: 5 } } } }]
    expect(await wait({ fn: "() => window.app && window.app.count", arg: 1 })).toMatchObject({ value: { n: 5 } })
  })

  it("fn: a function that throws fails at once with its error", async () => {
    state.evals = [{ result: {}, exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: app is not defined\n    at x" } } }]
    await expect(wait({ fn: "() => app.ready" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "wait function threw: ReferenceError: app is not defined" })
  })

  it("idle: network quiet and the page agent quiet", async () => {
    expect(await wait({ idle: true })).toMatchObject({ ms: expect.any(Number) })
  })
})
