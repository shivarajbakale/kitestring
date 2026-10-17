import { describe, expect, it, vi } from "vitest"

describe("loadSessions", () => {
  it("does not cache a failed load: the next call retries", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue({ "kite.sessions": [{ name: "a", groupId: 3, activeTabId: 7, tabs: [7] }] })
    ;(globalThis as { chrome?: unknown }).chrome = {
      storage: { session: { get } },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 7 }]) },
    }
    const sessions = await import("../background/sessions")
    await expect(sessions.loadSessions()).rejects.toThrow("storage unavailable")
    await sessions.loadSessions()
    expect(get).toHaveBeenCalledTimes(2)
    expect(sessions.sessionNames()).toEqual(["a"])
    await sessions.loadSessions() // a successful load stays memoised
    expect(get).toHaveBeenCalledTimes(2)
  })
})
