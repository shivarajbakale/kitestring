import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../background/agent-bridge", () => ({ isRestrictedUrl: () => false }))

describe("idle detach", () => {
  let attach: ReturnType<typeof vi.fn>
  let detach: ReturnType<typeof vi.fn>
  let sendCommand: ReturnType<typeof vi.fn>
  let onDetach: ((source: { tabId?: number }) => void) | undefined

  async function load() {
    vi.resetModules()
    attach = vi.fn(async () => {})
    detach = vi.fn(async () => {})
    sendCommand = vi.fn(async () => ({}))
    ;(globalThis as { chrome?: unknown }).chrome = {
      debugger: {
        attach,
        detach,
        sendCommand,
        onEvent: { addListener: () => {} },
        onDetach: { addListener: (f: typeof onDetach) => (onDetach = f) },
      },
      tabs: {
        get: vi.fn(async (id: number) => ({ id, url: "https://example.com/" })),
        onRemoved: { addListener: () => {} },
      },
    }
    const cdp = await import("../background/cdp")
    cdp.initCdp()
    return cdp
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("detaches after IDLE_DETACH_MS with no commands, and re-attaches on the next use", async () => {
    const cdp = await load()
    await cdp.ensureAttached(7)
    await vi.advanceTimersByTimeAsync(cdp.IDLE_DETACH_MS - 1)
    expect(detach).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(detach).toHaveBeenCalledWith({ tabId: 7 })
    await cdp.ensureAttached(7)
    expect(attach).toHaveBeenCalledTimes(2)
  })

  it("each command restarts the idle clock", async () => {
    const cdp = await load()
    await cdp.ensureAttached(7)
    await vi.advanceTimersByTimeAsync(cdp.IDLE_DETACH_MS - 1000)
    await cdp.send(7, "Runtime.evaluate")
    await vi.advanceTimersByTimeAsync(cdp.IDLE_DETACH_MS - 1000)
    expect(detach).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it("never detaches while a hold is open", async () => {
    const cdp = await load()
    await cdp.ensureAttached(7)
    const release = cdp.hold(7)
    await vi.advanceTimersByTimeAsync(cdp.IDLE_DETACH_MS * 3)
    expect(detach).not.toHaveBeenCalled()
    release()
    await vi.advanceTimersByTimeAsync(cdp.IDLE_DETACH_MS)
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it("does not detach a tab the user already detached (infobar Cancel)", async () => {
    const cdp = await load()
    await cdp.ensureAttached(7)
    onDetach?.({ tabId: 7 })
    await vi.advanceTimersByTimeAsync(cdp.IDLE_DETACH_MS)
    expect(detach).not.toHaveBeenCalled()
  })

  it("an attach right after an idle detach waits for the detach to settle", async () => {
    const cdp = await load()
    let settle!: () => void
    detach.mockImplementation(() => new Promise<void>((r) => (settle = r)))
    await cdp.ensureAttached(7)
    await vi.advanceTimersByTimeAsync(cdp.IDLE_DETACH_MS)
    const again = cdp.ensureAttached(7)
    await vi.advanceTimersByTimeAsync(0)
    expect(attach).toHaveBeenCalledTimes(1)
    settle()
    await again
    expect(attach).toHaveBeenCalledTimes(2)
  })
})
