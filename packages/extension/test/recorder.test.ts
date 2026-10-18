import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { echoEntry, type RecordedEvent } from "@kitestring/protocol"

type Listener = (...a: any[]) => any
let store: Record<string, unknown>
let onMessage: Listener
let onUpdated: Listener
let onRemoved: Listener
let onStartup: Listener
let sent: { tabId: number; msg: any }[]
let tabUrl: string

beforeEach(() => {
  vi.resetModules()
  store = {}
  sent = []
  tabUrl = "http://127.0.0.1:4173/basic-form?x=1"
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: "ext",
      onMessage: { addListener: (cb: Listener) => (onMessage = cb) },
      onStartup: { addListener: (cb: Listener) => (onStartup = cb) },
      onInstalled: { addListener: () => {} },
      getManifest: () => ({ content_scripts: [{ js: ["agent.js"] }] }),
    },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: tabUrl })),
      sendMessage: vi.fn(async (tabId: number, msg: unknown) => {
        sent.push({ tabId, msg })
        return { ok: true }
      }),
      onUpdated: { addListener: (cb: Listener) => (onUpdated = cb) },
      onRemoved: { addListener: (cb: Listener) => (onRemoved = cb) },
    },
    scripting: { executeScript: vi.fn(async () => []) },
    storage: {
      session: {
        get: vi.fn(async (k: string) => (k in store ? { [k]: store[k] } : {})),
        set: vi.fn(async (o: Record<string, unknown>) => Object.assign(store, structuredClone(o))),
        remove: vi.fn(async (k: string) => void delete store[k]),
      },
    },
  }
})
afterEach(() => vi.useRealTimers())

/** The salt the background armed the page with (what the page hashes values with). */
const salt = (): string => sent.find((s) => s.msg.kiteRecord === "start")!.msg.state.salt
const fill = (text: string, param: string, echo?: string): RecordedEvent => ({
  step: { action: "fill", target: { text, role: "textbox" }, value: `{{${param}}}` },
  params: [{ name: param, secret: false }],
  echoes: echo ? [echoEntry(echo, param, salt())!] : [],
})
const click = (text: string): RecordedEvent => ({ step: { action: "click", target: { text, role: "button" } }, params: [], echoes: [] })
const fromTab = (tabId: number, event: RecordedEvent) =>
  onMessage({ kiteRecord: "event", event }, { id: "ext", tab: { id: tabId }, frameId: 0 }, () => {})
const stored = () => store["kite.recording"] as { echoes: unknown[]; salt: string; at: string; active: boolean } | undefined

async function load() {
  const rec = await import("../background/recorder")
  rec.listenRecorder()
  return rec
}

describe("background recorder", () => {
  it("arms the tab with a random salt, keeps only its top frame's events, and returns the recording on stop", async () => {
    const rec = await load()
    // the query is never kept: it can hold tokens
    const start = "http://127.0.0.1:4173/basic-form"
    expect(await rec.startRecording(5, "ada-signup")).toEqual({ name: "ada-signup", tab: 5, url: start })
    expect(sent).toEqual([{ tabId: 5, msg: { kiteRecord: "start", state: { used: [], echoes: [], salt: expect.stringMatching(/^[0-9a-f]{32}$/) } } }])
    expect(rec.isRecording(5)).toBe(true)
    expect(rec.isRecording(6)).toBe(false)

    fromTab(5, fill("Name", "name", "Ada"))
    fromTab(6, fill("Other tab", "x"))
    onMessage({ kiteRecord: "event", event: click("iframe") }, { id: "ext", tab: { id: 5 }, frameId: 3 }, () => {})
    fromTab(5, click("Submit"))
    await rec.ready()

    const r = await rec.stopRecording()
    expect(r).toEqual({
      name: "ada-signup",
      url: start,
      steps: [
        { action: "fill", target: { text: "Name", role: "textbox" }, value: "{{name}}" },
        { action: "click", target: { text: "Submit", role: "button" } },
      ],
      secrets: [],
      skipped: [],
    })
    expect(sent.at(-1)).toEqual({ tabId: 5, msg: { kiteRecord: "stop" } })
    expect(rec.isRecording(5)).toBe(false)
    expect(stored()).toBeUndefined()
    await expect(rec.stopRecording()).rejects.toThrow(/not recording/)
  })

  it("each recording has its own salt", async () => {
    const rec = await load()
    await rec.startRecording(5, "a")
    const first = salt()
    await rec.stopRecording()
    sent = []
    await rec.startRecording(5, "b")
    expect(salt()).not.toBe(first)
  })

  it("peek returns the steps so far without ending the recording", async () => {
    const rec = await load()
    await rec.startRecording(5, "a")
    fromTab(5, click("Go"))
    expect((await rec.peekRecording()).steps).toEqual([click("Go").step])
    expect(rec.isRecording(5)).toBe(true)
    fromTab(5, click("More"))
    expect((await rec.stopRecording()).steps).toHaveLength(2)
  })

  it("a caused navigation pins the URL where it settles (after 1 s quiet) on its step; a new page is re-armed", async () => {
    vi.useFakeTimers()
    const rec = await load()
    await rec.startRecording(5, "x")
    fromTab(5, fill("Name", "name", "Ada"))
    fromTab(5, click("Next"))
    await rec.ready()
    // a redirect chain: the intermediate URL must not be the expect
    onUpdated(5, { url: "http://127.0.0.1:4173/auth/callback?code=1", status: "loading" }, { id: 5 })
    await vi.advanceTimersByTimeAsync(300)
    onUpdated(5, { url: "http://127.0.0.1:4173/orders/123?y=2" }, { id: 5 })
    onUpdated(5, { status: "complete" }, { id: 5, url: "http://127.0.0.1:4173/orders/123" })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(sent.filter((s) => s.msg.kiteRecord === "start")).toHaveLength(2)
    const rearm = sent.filter((s) => s.msg.kiteRecord === "start")[1]!.msg.state
    expect(rearm).toEqual({ used: ["name"], echoes: [echoEntry("Ada", "name", salt())], salt: salt() })

    // a path segment that echoes a typed value is not stored either
    fromTab(5, click("Profile"))
    await rec.ready()
    onUpdated(5, { url: "http://127.0.0.1:4173/users/ada/profile" }, { id: 5 })
    const r = await rec.stopRecording() // settles the pending navigation
    expect(r.steps[1]).toEqual({ action: "click", target: { text: "Next", role: "button" }, expect: { url: "/^[^:/]+://[^/]+/orders/[^/?#]+(?:[?#]|$)/" } })
    expect(r.steps[2]).toEqual({ action: "click", target: { text: "Profile", role: "button" }, expect: { url: "/^[^:/]+://[^/]+/users/[^/?#]+/profile(?:[?#]|$)/" } })
    expect(JSON.stringify(r)).not.toMatch(/ada|callback/i)
  })

  it("a navigation with no step in the second before it (address bar, back button) is not pinned to a step", async () => {
    vi.useFakeTimers()
    const rec = await load()
    await rec.startRecording(5, "x")
    fromTab(5, click("Next"))
    await rec.ready()
    await vi.advanceTimersByTimeAsync(1_500)
    onUpdated(5, { url: "http://127.0.0.1:4173/elsewhere" }, { id: 5 })
    await vi.advanceTimersByTimeAsync(1_500)
    expect((await rec.stopRecording()).steps).toEqual([click("Next").step])
  })

  it("collects secret param names and skipped fields, and survives a service-worker restart", async () => {
    const rec = await load()
    await rec.startRecording(5, "login")
    fromTab(5, { step: { action: "fill", target: { text: "Password", role: "textbox" }, value: "{{password}}" }, params: [{ name: "password", secret: true }], echoes: [] })
    fromTab(5, { step: null, params: [], echoes: [], skipped: "date input 'Birthday'" })
    fromTab(5, { step: null, params: [], echoes: [], skipped: "date input 'Birthday'" })
    await rec.ready()
    vi.resetModules()
    const again = await load()
    await again.ready()
    expect(again.isRecording(5)).toBe(true)
    const r = await again.stopRecording()
    expect(r.secrets).toEqual(["password"])
    expect(r.skipped).toEqual(["date input 'Birthday'"])
    expect(r.steps).toHaveLength(1)
  })

  it("refuses a second recording; a stop from the panel keeps the steps but drops the hashes, salt and path", async () => {
    const rec = await load()
    await rec.startRecording(5, "a")
    await expect(rec.startRecording(6, "b")).rejects.toThrow(/already recording a/)
    fromTab(5, fill("Name", "name", "Ada"))
    await rec.stopFromPanel()
    expect(sent.at(-1)!.msg).toEqual({ kiteRecord: "stop" })
    expect(rec.isRecording(5)).toBe(false)
    expect(rec.recordingStatus()).toEqual({ name: "a", active: false })
    expect(stored()).toMatchObject({ echoes: [], salt: "", at: "", active: false })
    fromTab(5, click("After"))
    expect((await rec.stopRecording()).steps).toEqual([fill("Name", "name").step])
    expect(rec.recordingStatus()).toBeNull()
  })

  it("closing the recorded tab ends the recording, drops the hashes, and keeps the steps", async () => {
    const rec = await load()
    await rec.startRecording(5, "a")
    fromTab(5, fill("Name", "name", "Ada"))
    onRemoved(5)
    await rec.ready()
    expect(rec.isRecording(5)).toBe(false)
    expect(stored()).toMatchObject({ echoes: [], salt: "", at: "", active: false })
    expect((await rec.stopRecording()).steps).toHaveLength(1)
  })

  it("a browser or extension restart drops the recording entirely", async () => {
    const rec = await load()
    await rec.startRecording(5, "a")
    onStartup()
    await rec.ready()
    expect(stored()).toBeUndefined()
    expect(rec.recordingStatus()).toBeNull()
  })

  it("the tab lock refuses the recorded tab only while it is recorded", async () => {
    const rec = await load()
    const { withTabLock } = await import("../background/serial")
    await rec.startRecording(5, "a")
    const fn = vi.fn(async () => "ran")
    await expect(withTabLock(5, fn)).rejects.toThrow("tab 5 is being recorded by the user")
    expect(fn).not.toHaveBeenCalled()
    expect(await withTabLock(6, fn)).toBe("ran")
    await rec.stopRecording()
    expect(await withTabLock(5, fn)).toBe("ran")
  })
})
