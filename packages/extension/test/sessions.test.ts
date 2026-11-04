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

describe("tab watcher", () => {
  type Tab = { id: number; windowId: number; openerTabId?: number }

  async function setup(stored: unknown[], live: Tab[]) {
    vi.resetModules()
    const tabs = new Map(live.map((t) => [t.id, t]))
    const created: ((t: Tab) => void)[] = []
    const removed: ((id: number) => void)[] = []
    const group = vi.fn().mockResolvedValue(99)
    ;(globalThis as { chrome?: unknown }).chrome = {
      storage: { session: { get: vi.fn().mockResolvedValue({ "kite.sessions": stored }), set: vi.fn().mockResolvedValue(undefined) } },
      tabs: {
        query: vi.fn(async () => [...tabs.values()]),
        get: vi.fn(async (id: number) => tabs.get(id)),
        group,
        onCreated: { addListener: (f: (t: Tab) => void) => created.push(f) },
        onRemoved: { addListener: (f: (id: number) => void) => removed.push(f) },
      },
      tabGroups: { update: vi.fn().mockResolvedValue(undefined) },
    }
    const sessions = await import("../background/sessions")
    sessions.watchTabs()
    await sessions.loadSessions()
    /** Opens `t` while its opener has an action in flight (unless `idle`). */
    const open = async (t: Tab, opts: { idle?: boolean } = {}) => {
      tabs.set(t.id, t)
      const done = !opts.idle && t.openerTabId !== undefined ? sessions.agentActing(t.openerTabId) : () => {}
      for (const f of created) f(t)
      await new Promise((r) => setTimeout(r, 20))
      done()
    }
    const close = async (id: number) => {
      tabs.delete(id)
      for (const f of removed) f(id)
      await new Promise((r) => setTimeout(r, 20))
    }
    return { sessions, open, close, group }
  }

  const stored = [
    { name: "a", groupId: 5, activeTabId: 1, tabs: [1] },
    { name: "b", groupId: 6, activeTabId: 2, tabs: [2] },
  ]
  const base: Tab[] = [
    { id: 1, windowId: 1 },
    { id: 2, windowId: 1 },
  ]

  it("adopts a tab opened by a session's tab, and only that session", async () => {
    const { sessions, open } = await setup(stored, base)
    await open({ id: 10, windowId: 1, openerTabId: 1 })
    expect(sessions.findSession("a")!.tabs.has(10)).toBe(true)
    expect(sessions.findSession("b")!.tabs.has(10)).toBe(false)
    expect(sessions.openerOf(sessions.findSession("a")!, 10)).toBe(1)
  })

  it("ignores tabs whose opener belongs to no session", async () => {
    const { sessions, open } = await setup(stored, [...base, { id: 3, windowId: 1 }])
    await open({ id: 11, windowId: 1, openerTabId: 3 })
    expect(sessions.findSession("a")!.tabs.has(11)).toBe(false)
  })

  it("owns but does not group a popup in another window", async () => {
    const { sessions, open, group } = await setup(stored, base)
    await open({ id: 12, windowId: 2, openerTabId: 1 })
    expect(sessions.findSession("a")!.tabs.has(12)).toBe(true)
    expect(group).not.toHaveBeenCalled()
  })

  it("groups a same-window tab", async () => {
    const { open, group } = await setup(stored, base)
    await open({ id: 13, windowId: 1, openerTabId: 1 })
    expect(group).toHaveBeenCalledWith({ groupId: 5, tabIds: [13] })
  })

  it("closing the active popup makes the opener active again", async () => {
    const { sessions, open, close } = await setup(stored, base)
    const a = sessions.findSession("a")!
    await open({ id: 14, windowId: 2, openerTabId: 1 })
    a.activeTabId = 14
    await close(14)
    expect(a.tabs.has(14)).toBe(false)
    expect(a.activeTabId).toBe(1)
  })

  it("newestAdopted returns the latest adopted tab, optionally after a time", async () => {
    const { sessions, open } = await setup(stored, base)
    const a = sessions.findSession("a")!
    expect(sessions.newestAdopted(a)).toBeUndefined()
    await open({ id: 20, windowId: 1, openerTabId: 1 })
    await new Promise((r) => setTimeout(r, 15))
    const mid = Date.now()
    await new Promise((r) => setTimeout(r, 15))
    await open({ id: 21, windowId: 1, openerTabId: 1 })
    expect(sessions.newestAdopted(a)).toBe(21)
    expect(sessions.newestAdopted(a, mid)).toBe(21)
    expect(sessions.newestAdopted(a, Date.now() + 1000)).toBeUndefined()
  })

  it("openers survive a restart (persisted and reloaded)", async () => {
    const withOpener = [{ ...stored[0], tabs: [1, 30], opener: [[30, 1]], adoptedAt: [[30, 123]] }, stored[1]]
    const { sessions } = await setup(withOpener, [...base, { id: 30, windowId: 2 }])
    await sessions.loadSessions()
    expect(sessions.openerOf(sessions.findSession("a")!, 30)).toBe(1)
  })

  it("a tab the human opens from an idle agent tab (middle-click) is not adopted", async () => {
    const { sessions, open } = await setup(stored, base)
    await open({ id: 40, windowId: 1, openerTabId: 1 }, { idle: true })
    expect(sessions.findSession("a")!.tabs.has(40)).toBe(false)
  })

  it("adopts during an action and up to 5 s after it ended, not later", async () => {
    const { sessions, open } = await setup(stored, base)
    const a = sessions.findSession("a")!
    const done = sessions.agentActing(1)
    await open({ id: 41, windowId: 1, openerTabId: 1 }, { idle: true })
    expect(a.tabs.has(41)).toBe(true)
    done()
    const ended = Date.now()
    const now = vi.spyOn(Date, "now")
    now.mockReturnValue(ended + 4_900)
    await open({ id: 42, windowId: 1, openerTabId: 1 }, { idle: true })
    expect(a.tabs.has(42)).toBe(true)
    now.mockReturnValue(ended + 5_100)
    await open({ id: 43, windowId: 1, openerTabId: 1 }, { idle: true })
    expect(a.tabs.has(43)).toBe(false)
    now.mockRestore()
  })

  it("a failing adoption does not leave an unhandled rejection", async () => {
    const { sessions, open } = await setup(stored, base)
    ;(chrome.storage.session.set as any).mockRejectedValueOnce(new Error("storage quota"))
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)
    await open({ id: 44, windowId: 1, openerTabId: 1 })
    await new Promise((r) => setTimeout(r, 20))
    process.off("unhandledRejection", unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    expect(sessions.findSession("a")).toBeDefined()
  })
})

describe("where a session's tabs open", () => {
  async function setup() {
    vi.resetModules()
    let nextTab = 100
    let nextWin = 50
    const tabs = new Map<number, { id: number; windowId: number; status: string; url: string }>()
    const windows = new Map<number, { id: number; type: string; state: string }>()
    const created: { how: string; opts: Record<string, unknown> }[] = []
    const newTabIn = (windowId: number) => {
      const t = { id: nextTab++, windowId, status: "complete", url: "about:blank" }
      tabs.set(t.id, t)
      return t
    }
    const ev = { addListener: vi.fn(), removeListener: vi.fn() }
    ;(globalThis as { chrome?: unknown }).chrome = {
      storage: { session: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) } },
      tabs: {
        query: vi.fn(async () => [...tabs.values()]),
        get: vi.fn(async (id: number) => tabs.get(id)),
        create: vi.fn(async (o: { windowId?: number }) => {
          created.push({ how: "tab", opts: o })
          return newTabIn(o.windowId ?? 1)
        }),
        group: vi.fn().mockResolvedValue(7),
        onUpdated: ev,
        onRemoved: ev,
        onCreated: ev,
      },
      windows: {
        create: vi.fn(async (o: Record<string, unknown>) => {
          created.push({ how: "window", opts: o })
          const w = { id: nextWin++, type: "normal", state: "normal" }
          windows.set(w.id, w)
          return { id: w.id, tabs: [newTabIn(w.id)] }
        }),
        get: vi.fn(async (id: number) => {
          const w = windows.get(id)
          if (!w) throw new Error("No window with id")
          return w
        }),
      },
      tabGroups: { update: vi.fn().mockResolvedValue(undefined), get: vi.fn(async () => ({ windowId: 50 })) },
      debugger: { attach: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn().mockResolvedValue({}), onEvent: ev, onDetach: ev },
    }
    const sessions = await import("../background/sessions")
    await sessions.loadSessions()
    return { sessions, created, windows }
  }

  it("an agent's tab opens in the person's window; a job's own window counts as the agent's, and its group stays in it", async () => {
    const { sessions, created } = await setup()
    const s = sessions.getOrCreateSession("a")
    await sessions.newTab(s)
    expect(created[0]).toEqual({ how: "tab", opts: { url: "about:blank", active: true } })
    expect(s.windowId).toBeNull()
    expect(sessions.isAgentWindow(1)).toBe(false)
    const job = sessions.getOrCreateSession("job-x")
    await sessions.newTab(job, undefined, { ownWindow: true })
    expect(created[1]).toMatchObject({ how: "window", opts: { focused: true } })
    expect(job.windowId).toBe(50)
    expect(sessions.isAgentWindow(50)).toBe(true)
    // A new group goes in the tab's own window (Chrome would put it in the focused one, moving the tab there).
    const group = (globalThis as any).chrome.tabs.group
    expect(group).toHaveBeenLastCalledWith({ tabIds: [101], createProperties: { windowId: 50 } })
    await sessions.newTab(sessions.getOrCreateSession("w"), undefined, { background: true })
    expect(created[2]).toEqual({ how: "tab", opts: { url: "about:blank", active: false } })
  })
})
