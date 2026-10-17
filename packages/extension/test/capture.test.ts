import { describe, expect, it } from "vitest"
import { MAX_TEXT, RING_SIZE, TabCapture, pngSize } from "../background/capture"

const api = (type: string, args: object[], url = "https://s.test/app.js", lineNumber = 11) => [
  "Runtime.consoleAPICalled",
  { type, args, stackTrace: { callFrames: [{ url, lineNumber }] } },
] as const
const feed = (c: TabCapture, [m, p]: readonly [string, object], now = 1) => c.onEvent(m, p as Record<string, unknown>, now)

describe("console capture", () => {
  it("joins args (value / description) and maps level and 1-based line", () => {
    const c = new TabCapture()
    feed(c, api("warning", [{ type: "string", value: "hi" }, { type: "object", description: "Object" }, { type: "number", value: 3 }]))
    expect(c.consoleEntries()).toEqual([{ ts: 1, level: "warn", text: "hi Object 3", url: "https://s.test/app.js", line: 12, nav: 0 }])
  })

  it("records uncaught exceptions as errors using the exception description", () => {
    const c = new TabCapture()
    c.onEvent("Runtime.exceptionThrown", {
      exceptionDetails: { text: "Uncaught", url: "https://s.test/x.js", lineNumber: 4, exception: { type: "object", description: "Error: kaboom\n    at f" } },
    })
    expect(c.consoleEntries({ level: "error" })[0]).toMatchObject({ level: "error", text: "Error: kaboom\n    at f", line: 5 })
  })

  it("caps text at 2000 chars, filters by level, limits to the newest, clears", () => {
    const c = new TabCapture()
    feed(c, api("log", [{ type: "string", value: "x".repeat(MAX_TEXT + 50) }]))
    expect(c.consoleEntries()[0]!.text).toHaveLength(MAX_TEXT)
    feed(c, api("error", [{ type: "string", value: "e1" }]))
    feed(c, api("warning", [{ type: "string", value: "w1" }]))
    feed(c, api("error", [{ type: "string", value: "e2" }]))
    expect(c.consoleEntries({ level: "error" }).map((e) => e.text)).toEqual(["e1", "e2"])
    expect(c.consoleEntries({ level: "warn" }).map((e) => e.text)).toEqual(["e1", "w1", "e2"])
    expect(c.consoleEntries({ limit: 2 }).map((e) => e.text)).toEqual(["w1", "e2"])
    c.consoleEntries({ clear: true })
    expect(c.consoleEntries()).toEqual([])
  })

  it("keeps only the newest 500", () => {
    const c = new TabCapture()
    for (let i = 0; i < RING_SIZE + 10; i++) feed(c, api("log", [{ type: "string", value: `m${i}` }]))
    const all = c.consoleEntries({ limit: 10_000 })
    expect(all).toHaveLength(RING_SIZE)
    expect(all[0]!.text).toBe("m10")
  })
})

describe("network capture", () => {
  const sent = (c: TabCapture, id: string, url: string, ts = 10, extra: object = {}) =>
    c.onEvent("Network.requestWillBeSent", { requestId: id, timestamp: ts, type: "Fetch", request: { url, method: "GET" }, ...extra })

  it("tracks status, duration and failed (status >= 400)", () => {
    const c = new TabCapture()
    sent(c, "1", "https://s.test/ok")
    c.onEvent("Network.responseReceived", { requestId: "1", response: { status: 200 } })
    c.onEvent("Network.loadingFinished", { requestId: "1", timestamp: 10.034 })
    sent(c, "2", "https://s.test/status/500")
    c.onEvent("Network.responseReceived", { requestId: "2", response: { status: 500 } })
    c.onEvent("Network.loadingFinished", { requestId: "2", timestamp: 10.5 })
    expect(c.networkEntries().map((e) => [e.status, e.failed, e.ms])).toEqual([[200, false, 34], [500, true, 500]])
    expect(c.networkEntries({ failed: true }).map((e) => e.url)).toEqual(["https://s.test/status/500"])
    expect(c.networkEntries({ filter: "/ok" })).toHaveLength(1)
  })

  it("marks loadingFailed requests failed with the error text", () => {
    const c = new TabCapture()
    sent(c, "1", "https://s.test/x")
    c.onEvent("Network.loadingFailed", { requestId: "1", timestamp: 11, errorText: "net::ERR_FAILED" })
    expect(c.networkEntries()[0]).toMatchObject({ failed: true, error: "net::ERR_FAILED", ms: 1000 })
  })

  it("does not treat a canceled bodiless response (204) as failed", () => {
    const c = new TabCapture()
    sent(c, "1", "https://s.test/analytics/x")
    c.onEvent("Network.responseReceived", { requestId: "1", response: { status: 204 } })
    c.onEvent("Network.loadingFailed", { requestId: "1", timestamp: 10.007, errorText: "net::ERR_ABORTED", canceled: true })
    expect(c.networkEntries()[0]).toMatchObject({ status: 204, failed: false, ms: 7 })
    expect(c.networkEntries()[0]!.error).toBeUndefined()
  })

  it("records a redirect hop with its own status and follows the next request", () => {
    const c = new TabCapture()
    sent(c, "1", "https://s.test/a")
    sent(c, "1", "https://s.test/b", 10.1, { redirectResponse: { status: 302 } })
    c.onEvent("Network.responseReceived", { requestId: "1", response: { status: 200 } })
    expect(c.networkEntries().map((e) => [e.url, e.status])).toEqual([["https://s.test/a", 302], ["https://s.test/b", 200]])
  })

  it("keeps entries across main-frame navigations by default, counting them; child frames do not count", () => {
    const c = new TabCapture()
    sent(c, "1", "https://s.test/a")
    c.onEvent("Page.frameNavigated", { frame: { id: "F" } })
    c.onEvent("Page.frameNavigated", { frame: { id: "C", parentId: "F" } })
    sent(c, "2", "https://s.test/b")
    expect(c.networkEntries().map((e) => e.nav)).toEqual([0, 1])
  })

  it("resets on main-frame navigation when preserve is false", () => {
    const c = new TabCapture()
    c.preserve = false
    sent(c, "1", "https://s.test/a")
    feed(c, api("log", [{ type: "string", value: "old" }]))
    c.onEvent("Page.frameNavigated", { frame: { id: "F" } })
    expect(c.networkEntries()).toEqual([])
    expect(c.consoleEntries()).toEqual([])
  })

  it("keeps only the newest 500", () => {
    const c = new TabCapture()
    for (let i = 0; i < RING_SIZE + 5; i++) sent(c, String(i), `https://s.test/${i}`)
    const all = c.networkEntries({ limit: 10_000 })
    expect(all).toHaveLength(RING_SIZE)
    expect(all[0]!.url).toBe("https://s.test/5")
  })
})

describe("pngSize", () => {
  it("reads width and height from the IHDR", () => {
    const b = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
    b.writeUInt32BE(1280, 16)
    b.writeUInt32BE(3050, 20)
    expect(pngSize(b.toString("base64"))).toEqual({ width: 1280, height: 3050 })
  })
})
