import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActionResult } from "@kitestring/protocol"

vi.mock("@kitestring/page-agent", () => ({ diffSnapshots: () => ({ added: [], removed: [] }) }))
vi.mock("../background/agent-bridge", () => ({
  callAgent: vi.fn(async () => "brief"),
  isRestrictedUrl: () => false,
}))
vi.mock("../background/cdp", () => ({ ensureAttached: vi.fn(), isNotAttached: () => false, onEvent: vi.fn(), send: vi.fn() }))
vi.mock("../background/input", () => ({}))
vi.mock("../background/network-idle", () => ({ trackNetwork: vi.fn() }))
vi.mock("../background/sessions", () => ({ activeTab: vi.fn(), adoptTab: vi.fn() }))
vi.mock("../background/control", () => ({ assertNotPaused: vi.fn() }))

const done: ActionResult = { ok: true, status: "done", diff: { added: [], removed: [] }, page: "P" }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("capped", () => {
  it("a waiter whose cap expires in the queue answers timeout without running", async () => {
    const { capped } = await import("../background/pipeline")
    let release!: () => void
    const holder = capped(1, () => new Promise<ActionResult>((r) => (release = () => r(done))))
    await vi.advanceTimersByTimeAsync(5_000)
    let ran = false
    const waiter = capped(1, async () => {
      ran = true
      return done
    })
    await vi.advanceTimersByTimeAsync(10_000) // holder's cap fires (15 s), but its body keeps the lock
    expect((await holder).detail).toBe("action did not finish within 15000 ms")
    await vi.advanceTimersByTimeAsync(5_000) // waiter's own 15 s
    const w = await waiter
    expect(w).toMatchObject({ ok: false, status: "timeout", detail: "waited for another action on this tab" })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(ran).toBe(false)
    expect(await capped(1, async () => done)).toBe(done) // lock is free again
  })

  it("a cap timeout carries the dialogs handled so far", async () => {
    const { capped } = await import("../background/pipeline")
    const ev = { type: "alert" as const, message: "Hi", handled: "accepted" as const }
    const r = capped(3, (p) => {
      p.dialogs = [ev]
      return new Promise<ActionResult>(() => {})
    })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await r).toMatchObject({ status: "timeout", dialogs: [ev] })
  })

  it("R14: an RpcError TIMEOUT from the body becomes a timeout ActionResult", async () => {
    const { capped } = await import("../background/pipeline")
    const { RpcError } = await import("../background/errors")
    const r = await capped(2, async () => {
      throw new RpcError("TIMEOUT", "TIMEOUT: page in tab 2 did not become scriptable")
    })
    expect(r).toEqual({
      ok: false,
      status: "timeout",
      detail: "TIMEOUT: page in tab 2 did not become scriptable",
      diff: { added: [], removed: [] },
      page: "",
    })
  })

  it("other RPC errors still propagate", async () => {
    const { capped } = await import("../background/pipeline")
    const { RpcError } = await import("../background/errors")
    await expect(
      capped(3, async () => {
        throw new RpcError("NO_TAB", "NO_TAB: x")
      }),
    ).rejects.toThrow("NO_TAB: x")
  })

  it("a holder stuck past its cap gives up the tab lock 5 s after the cap", async () => {
    const { capped } = await import("../background/pipeline")
    const stuck = capped(4, () => new Promise<ActionResult>(() => {})) // e.g. CDP blocked by alert()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await stuck).toMatchObject({ status: "timeout", detail: "action did not finish within 15000 ms" })
    let ran = false
    const next = capped(4, async () => {
      ran = true
      return done
    })
    await vi.advanceTimersByTimeAsync(4_900)
    expect(ran).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(await next).toBe(done)
    expect(ran).toBe(true)
  })
})
