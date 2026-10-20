import { beforeEach, describe, expect, it, vi } from "vitest"

let store: Record<string, unknown>
let badge: string
let buttonClicked: ((id: string, button: number) => void) | undefined
const created: { id: string; opts: { title: string; message: string } }[] = []
const cleared: string[] = []
const focused: number[] = []

beforeEach(() => {
  vi.resetModules()
  store = {}
  badge = ""
  buttonClicked = undefined
  created.length = 0
  cleared.length = 0
  focused.length = 0
  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: vi.fn(async (k: string) => (k in store ? { [k]: store[k] } : {})),
        set: vi.fn(async (o: Record<string, unknown>) => Object.assign(store, o)),
      },
    },
    action: {
      setBadgeText: vi.fn(async ({ text }: { text: string }) => void (badge = text)),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
    runtime: {
      getManifest: () => ({ icons: { "16": "icon16.png", "128": "icon128.png" } }),
      getURL: (p: string) => `chrome-extension://kite/${p}`,
      lastError: undefined,
    },
    notifications: {
      create: vi.fn((id: string, opts: { title: string; message: string }, cb: () => void) => {
        created.push({ id, opts })
        cb()
      }),
      clear: vi.fn((id: string, cb: () => void) => {
        cleared.push(id)
        cb()
      }),
      onButtonClicked: { addListener: (cb: typeof buttonClicked) => (buttonClicked = cb) },
      onClicked: { addListener: () => {} },
    },
    tabs: { update: vi.fn(async (id: number) => (focused.push(id), { id, windowId: 1 })) },
    windows: { update: vi.fn(async () => ({})) },
  }
})

describe("handoff", () => {
  it("opens a request: notification, badge, tab to the front, persisted", async () => {
    const handoff = await import("../background/handoff")
    const r = await handoff.ask("agent", 7, "Solve the captcha", 0)
    expect(r).toMatchObject({ status: "waiting", reason: "Solve the captcha" })
    expect(created).toEqual([{ id: "kite-handoff:agent", opts: expect.objectContaining({ title: "agent needs you", message: "Solve the captcha", iconUrl: "chrome-extension://kite/icon128.png" }) }])
    expect(badge).toBe("!")
    expect(focused).toEqual([7])
    expect(store["kite.handoff"]).toEqual([expect.objectContaining({ session: "agent", tabId: 7, reason: "Solve the captcha" })])
    expect(handoff.pending()).toHaveLength(1)
  })

  it("hands the answer to a waiting call and clears the request", async () => {
    const handoff = await import("../background/handoff")
    const asking = handoff.ask("agent", 7, "Enter the 2FA code", 5_000)
    await vi.waitFor(() => expect(created).toHaveLength(1))
    await handoff.answer("agent", "done")
    await expect(asking).resolves.toMatchObject({ status: "done", reason: "Enter the 2FA code" })
    expect(handoff.pending()).toEqual([])
    expect(badge).toBe("")
    expect(cleared).toEqual(["kite-handoff:agent"])
  })

  it("keeps waiting on the open request instead of opening another", async () => {
    const handoff = await import("../background/handoff")
    await handoff.ask("agent", 7, "Log in", 0)
    const again = await handoff.ask("agent", 7, "Log in", 10)
    expect(again.status).toBe("waiting")
    expect(created).toHaveLength(1)
  })

  it("keeps an answer given between calls for the next call with the same reason", async () => {
    const handoff = await import("../background/handoff")
    await handoff.ask("agent", 7, "Log in", 0)
    await handoff.answer("agent", "declined")
    expect(handoff.pending()).toEqual([])
    await expect(handoff.ask("agent", 7, "Log in", 0)).resolves.toMatchObject({ status: "declined" })
    // picked up once: asking again opens a new request
    await expect(handoff.ask("agent", 7, "Log in", 0)).resolves.toMatchObject({ status: "waiting" })
    expect(created).toHaveLength(2)
  })

  it("does not hand an old answer to a different question", async () => {
    const handoff = await import("../background/handoff")
    await handoff.ask("agent", 7, "Log in", 0)
    await handoff.answer("agent", "done")
    await expect(handoff.ask("agent", 7, "Approve the payment", 0)).resolves.toMatchObject({ status: "waiting", reason: "Approve the payment" })
  })

  it("a new question replaces the open one and notifies again", async () => {
    const handoff = await import("../background/handoff")
    const first = handoff.ask("agent", 7, "Log in", 5_000)
    await vi.waitFor(() => expect(created).toHaveLength(1))
    const second = handoff.ask("agent", 7, "Enter the 2FA code", 5_000)
    await expect(first).resolves.toMatchObject({ status: "waiting", reason: "Log in" })
    await vi.waitFor(() => expect(created).toHaveLength(2))
    expect(handoff.pending()).toEqual([expect.objectContaining({ reason: "Enter the 2FA code" })])
    await handoff.answer("agent", "done")
    await expect(second).resolves.toMatchObject({ status: "done", reason: "Enter the 2FA code" })
  })

  it("answers from the notification's buttons", async () => {
    const handoff = await import("../background/handoff")
    handoff.initHandoff()
    const asking = handoff.ask("agent", null, "Solve the captcha", 5_000)
    await vi.waitFor(() => expect(created).toHaveLength(1))
    buttonClicked!("kite-handoff:agent", 1)
    await expect(asking).resolves.toMatchObject({ status: "declined" })
    expect(focused).toEqual([]) // no tab to show
  })

  it("restores open requests after a service-worker restart", async () => {
    store["kite.handoff"] = [{ session: "agent", tabId: 3, reason: "Log in", since: 1 }]
    const handoff = await import("../background/handoff")
    await handoff.ready()
    expect(handoff.pending()).toEqual([{ session: "agent", tabId: 3, reason: "Log in", since: 1 }])
    await expect(handoff.ask("agent", 3, "Log in", 0)).resolves.toMatchObject({ status: "waiting", since: 1 })
    expect(created).toHaveLength(0) // already notified before the restart
  })
})
