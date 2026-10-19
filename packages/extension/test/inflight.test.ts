import { describe, expect, it } from "vitest"
import { InflightRequests } from "../background/inflight"

const sent = (requestId: string, loaderId: string, extra: Record<string, unknown> = {}) =>
  ["Network.requestWillBeSent", { requestId, loaderId, request: { url: `https://site.test/${requestId}` }, ...extra }] as const
const finished = (requestId: string) => ["Network.loadingFinished", { requestId }] as const
const mainNav = (loaderId: string) => ["Page.frameNavigated", { frame: { id: "F", loaderId } }] as const
const childNav = (loaderId: string) => ["Page.frameNavigated", { frame: { id: "C", parentId: "F", loaderId } }] as const

describe("InflightRequests", () => {
  it("counts requests until they finish or fail", () => {
    const t = new InflightRequests(0)
    t.onEvent(...sent("1", "L1"), 1)
    t.onEvent(...sent("2", "L1"), 2)
    expect(t.size).toBe(2)
    t.onEvent(...finished("1"), 3)
    t.onEvent("Network.loadingFailed", { requestId: "2" }, 4)
    expect(t.size).toBe(0)
    expect(t.quietSince).toBe(4)
  })

  it("ignores websockets, event streams, pings and analytics", () => {
    const t = new InflightRequests(0)
    t.onEvent(...sent("ws", "L1", { type: "WebSocket" }))
    t.onEvent(...sent("es", "L1", { type: "EventSource" }))
    t.onEvent(...sent("p", "L1", { type: "Ping" }))
    t.onEvent("Network.requestWillBeSent", { requestId: "ga", loaderId: "L1", request: { url: "https://www.google-analytics.com/collect" } })
    expect(t.size).toBe(0)
  })

  it("a main-frame navigation drops the old document's requests (they never finish)", () => {
    const t = new InflightRequests(0)
    t.onEvent(...sent("old-xhr", "L1"), 1)
    t.onEvent(...sent("old-img", "L1"), 1)
    t.onEvent(...sent("doc", "L2", { type: "Document" }), 2) // the new document's own request
    t.onEvent(...mainNav("L2"), 3)
    expect(t.size).toBe(1) // only the new document's request is still in flight
    t.onEvent(...finished("doc"), 4)
    expect(t.size).toBe(0)
    expect(t.quietSince).toBe(4)
  })

  it("dropping the last old request starts the quiet period", () => {
    const t = new InflightRequests(0)
    t.onEvent(...sent("old", "L1"), 1)
    t.onEvent(...mainNav("L2"), 5)
    expect(t.size).toBe(0)
    expect(t.quietSince).toBe(5)
  })

  it("a child-frame navigation keeps everything", () => {
    const t = new InflightRequests(0)
    t.onEvent(...sent("a", "L1"), 1)
    t.onEvent(...childNav("L9"), 2)
    expect(t.size).toBe(1)
  })

  it("ignores telemetry beacons that fire every few hundred ms (GitHub)", () => {
    const t = new InflightRequests(0)
    for (const url of [
      "https://collector.github.com/github/collect",
      "https://api.github.com/_private/browser/rum?ddforward=x",
      "https://api.github.com/_private/browser/errors",
      "https://browser-intake-datadoghq.eu/api/v2/rum",
    ])
      t.onEvent("Network.requestWillBeSent", { requestId: url, loaderId: "L1", request: { url } })
    expect(t.size).toBe(0)
  })

  it("a request in flight 5 s stops counting; the last one going starts the quiet period", () => {
    const t = new InflightRequests(0)
    t.onEvent(...sent("poll", "L1"), 1000)
    t.onEvent(...sent("api", "L1"), 4000)
    t.prune(5999)
    expect(t.size).toBe(2)
    t.prune(6000) // poll is 5 s old
    expect(t.size).toBe(1)
    t.onEvent(...finished("poll"), 6100) // its late end changes nothing
    expect(t.size).toBe(1)
    t.prune(9000)
    expect(t.size).toBe(0)
    expect(t.quietSince).toBe(9000)
  })

  it("a redirect keeps the request's first send time", () => {
    const t = new InflightRequests(0)
    t.onEvent(...sent("r", "L1"), 1000)
    t.onEvent(...sent("r", "L1"), 5500) // redirect hop reuses the id
    t.prune(6000)
    expect(t.size).toBe(0)
  })
})
