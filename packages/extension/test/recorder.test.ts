import { beforeEach, describe, expect, it, vi } from "vitest"
import { echoEntry, type RecordedEvent } from "@kitestring/protocol"

type Listener = (...a: any[]) => any
let store: Record<string, unknown>
let onMessage: Listener
let onUpdated: Listener
let onRemoved: Listener
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
        set: vi.fn(async (o: Record<string, unknown>) => Object.assign(store, o)),
        remove: vi.fn(async (k: string) => void delete store[k]),
      },
    },
  }
})

const fill = (text: string, param: string, echo?: string): RecordedEvent => ({
  step: { action: "fill", target: { text, role: "textbox" }, value: `{{${param}}}` },
  params: [{ name: param, secret: false }],
  echoes: echo ? [echoEntry(echo, param)!] : [],
})
const click = (text: string): RecordedEvent => ({ step: { action: "click", target: { text, role: "button" } }, params: [], echoes: [] })
const fromTab = (tabId: number, event: RecordedEvent) =>
  onMessage({ kiteRecord: "event", event }, { id: "ext", tab: { id: tabId }, frameId: 0 }, () => {})

async function load() {
  const rec = await import("../background/recorder")
  rec.listenRecorder()
  return rec
}

describe("background recorder", () => {
  it("arms the tab, keeps only its top frame's events, and returns the recording on stop", async () => {
    const rec = await load()
    // the query is never kept: it can hold tokens
    const start = "http://127.0.0.1:4173/basic-form"
    expect(await rec.startRecording(5, "ada-signup")).toEqual({ name: "ada-signup", tab: 5, url: start })
    expect(sent).toEqual([{ tabId: 5, msg: { kiteRecord: "start", state: { used: [], echoes: [] } } }])
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
    })
    expect(sent.at(-1)).toEqual({ tabId: 5, msg: { kiteRecord: "stop" } })
    expect(rec.isRecording(5)).toBe(false)
    await expect(rec.stopRecording()).rejects.toThrow(/not recording/)
  })

  it("a navigation right after a step becomes that step's expect (path pattern); a new page is re-armed", async () => {
    const rec = await load()
    await rec.startRecording(5, "x")
    fromTab(5, fill("Name", "name", "Ada"))
    fromTab(5, click("Next"))
    onUpdated(5, { url: "http://127.0.0.1:4173/orders/123?y=2", status: "loading" }, { id: 5 })
    onUpdated(5, { status: "complete" }, { id: 5, url: "http://127.0.0.1:4173/orders/123" })
    await vi.waitFor(() => expect(sent.filter((s) => s.msg.kiteRecord === "start")).toHaveLength(2))
    const rearm = sent.filter((s) => s.msg.kiteRecord === "start")[1]!.msg.state
    expect(rearm.used).toEqual(["name"])
    expect(rearm.echoes).toEqual([echoEntry("Ada", "name")])

    // a path segment that echoes a typed value is not stored either
    fromTab(5, click("Profile"))
    onUpdated(5, { url: "http://127.0.0.1:4173/users/ada/profile" }, { id: 5 })
    const r = await rec.stopRecording()
    expect(r.steps[1]).toEqual({ action: "click", target: { text: "Next", role: "button" }, expect: { url: "/^[^:/]+://[^/]+/orders/[^/?#]+(?:[?#]|$)/" } })
    expect(r.steps[2]).toEqual({ action: "click", target: { text: "Profile", role: "button" }, expect: { url: "/^[^:/]+://[^/]+/users/[^/?#]+/profile(?:[?#]|$)/" } })
    expect(JSON.stringify(r)).not.toMatch(/ada/i)
  })

  it("collects secret param names and survives a service-worker restart", async () => {
    const rec = await load()
    await rec.startRecording(5, "login")
    fromTab(5, { step: { action: "fill", target: { text: "Password", role: "textbox" }, value: "{{password}}" }, params: [{ name: "password", secret: true }], echoes: [] })
    await rec.ready()
    vi.resetModules()
    const again = await load()
    await again.ready()
    expect(again.isRecording(5)).toBe(true)
    expect((await again.stopRecording()).secrets).toEqual(["password"])
  })

  it("refuses a second recording; a stop from the panel keeps the steps for kite record stop", async () => {
    const rec = await load()
    await rec.startRecording(5, "a")
    await expect(rec.startRecording(6, "b")).rejects.toThrow(/already recording a/)
    fromTab(5, click("Go"))
    await rec.stopFromPanel()
    expect(sent.at(-1)!.msg).toEqual({ kiteRecord: "stop" })
    expect(rec.isRecording(5)).toBe(false)
    expect(rec.recordingStatus()).toEqual({ name: "a", active: false })
    fromTab(5, click("After"))
    expect((await rec.stopRecording()).steps).toEqual([click("Go").step])
    expect(rec.recordingStatus()).toBeNull()
  })

  it("closing the recorded tab ends the recording but keeps what was recorded", async () => {
    const rec = await load()
    await rec.startRecording(5, "a")
    fromTab(5, click("Go"))
    onRemoved(5)
    await rec.ready()
    expect(rec.isRecording(5)).toBe(false)
    expect((await rec.stopRecording()).steps).toHaveLength(1)
  })
})
