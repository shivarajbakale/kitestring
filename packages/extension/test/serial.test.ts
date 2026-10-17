import { describe, expect, it } from "vitest"
import { rejectWaiters, withTabLock } from "../background/serial"

const tick = () => new Promise((r) => setTimeout(r, 0))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe("withTabLock", () => {
  it("runs actions on the same tab one at a time, in FIFO order", async () => {
    const log: string[] = []
    const gate = deferred()
    const a = withTabLock(1, async () => {
      log.push("a:start")
      await gate.promise
      log.push("a:end")
      return "a"
    })
    const b = withTabLock(1, async () => {
      log.push("b")
      return "b"
    })
    const c = withTabLock(1, async () => {
      log.push("c")
      return "c"
    })
    await tick()
    expect(log).toEqual(["a:start"])
    gate.resolve()
    expect(await Promise.all([a, b, c])).toEqual(["a", "b", "c"])
    expect(log).toEqual(["a:start", "a:end", "b", "c"])
  })

  it("does not serialize different tabs", async () => {
    const gate = deferred()
    const a = withTabLock(1, () => gate.promise)
    let ran = false
    await withTabLock(2, async () => {
      ran = true
    })
    expect(ran).toBe(true)
    gate.resolve()
    await a
  })

  it("releases the lock when the holder throws", async () => {
    await expect(withTabLock(3, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(await withTabLock(3, async () => "next")).toBe("next")
  })

  it("an aborted waiter leaves the queue without running", async () => {
    const gate = deferred()
    const a = withTabLock(4, () => gate.promise)
    const ctl = new AbortController()
    let ran = false
    const b = withTabLock(
      4,
      async () => {
        ran = true
      },
      { signal: ctl.signal },
    )
    const c = withTabLock(4, async () => "c")
    ctl.abort(new Error("cap"))
    await expect(b).rejects.toThrow("cap")
    gate.resolve()
    expect(await c).toBe("c")
    await a
    expect(ran).toBe(false)
  })

  it("rejectWaiters rejects queued waiters but lets the holder finish", async () => {
    const gate = deferred()
    const log: string[] = []
    const a = withTabLock(5, async () => {
      await gate.promise
      log.push("a")
      return "a"
    })
    const b = withTabLock(5, async () => {
      log.push("b")
    })
    const other = withTabLock(6, async () => gate.promise) // holder on another tab: untouched
    await tick()
    rejectWaiters(new Error("paused"))
    await expect(b).rejects.toThrow("paused")
    gate.resolve()
    expect(await a).toBe("a")
    await other
    expect(log).toEqual(["a"])
    expect(await withTabLock(5, async () => "free")).toBe("free")
  })
})
