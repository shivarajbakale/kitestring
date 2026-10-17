import { describe, expect, it } from "vitest"
import type { ActivityEntry } from "@kitestring/protocol"
import { relativeTime } from "../ui/components/RelativeTime"
import { describeAction } from "../ui/components/SessionList"
import { isTrustedUiSender, parseUiRequest, REASON_MAX } from "../ui/messages"

describe("relativeTime", () => {
  const now = 1_000_000_000
  it.each([
    [0, "just now"],
    [4_000, "just now"],
    [12_000, "12s ago"],
    [4 * 60_000, "4m ago"],
    [3 * 3_600_000, "3h ago"],
    [50 * 3_600_000, "2d ago"],
    [-5_000, "just now"], // clock skew
  ])("%i ms ago → %s", (ago, text) => {
    expect(relativeTime(now - ago, now)).toBe(text)
  })
})

describe("describeAction", () => {
  const e = (method: string, target?: string) => ({ method, target }) as ActivityEntry
  it("drops the act. namespace and the URL scheme", () => {
    expect(describeAction(e("act.click", '"Pay now"'))).toBe('click "Pay now"')
    expect(describeAction(e("tab.new", "https://example.com/a"))).toBe("tab.new example.com/a")
    expect(describeAction(e("page.snapshot"))).toBe("page.snapshot")
  })
})

describe("UI message guard", () => {
  const ID = "bdfegcbeenjmlbfogodoibdhfbonnicm"
  const ORIGIN = `chrome-extension://${ID}/`
  it("accepts the extension's own pages, including popup.html opened as a tab", () => {
    expect(isTrustedUiSender({ id: ID, url: `${ORIGIN}popup.html` }, ID, ORIGIN)).toBe(true)
    expect(isTrustedUiSender({ id: ID, url: `${ORIGIN}sidepanel.html` }, ID, ORIGIN)).toBe(true)
  })
  it("rejects the extension's content script (same id, web page url) and other extensions", () => {
    expect(isTrustedUiSender({ id: ID, url: "https://evil.example/" }, ID, ORIGIN)).toBe(false)
    expect(isTrustedUiSender({ id: ID }, ID, ORIGIN)).toBe(false)
    expect(isTrustedUiSender({ id: "other", url: "chrome-extension://other/popup.html" }, ID, ORIGIN)).toBe(false)
    expect(isTrustedUiSender({ id: ID, url: `chrome-extension://${ID}.evil/` }, ID, ORIGIN)).toBe(false)
  })
})

describe("parseUiRequest", () => {
  it("accepts well-formed ops", () => {
    expect(parseUiRequest({ kite: "ui", op: "state" })).toEqual({ kite: "ui", op: "state" })
    expect(parseUiRequest({ kite: "ui", op: "resume", extra: 1 })).toEqual({ kite: "ui", op: "resume" })
    expect(parseUiRequest({ kite: "ui", op: "focusTab", session: "default" })).toEqual({ kite: "ui", op: "focusTab", session: "default" })
    expect(parseUiRequest({ kite: "ui", op: "openPanel", windowId: 3 })).toEqual({ kite: "ui", op: "openPanel", windowId: 3 })
    expect(parseUiRequest({ kite: "ui", op: "focusTab", session: "s", tabId: 42 })).toEqual({ kite: "ui", op: "focusTab", session: "s", tabId: 42 })
  })
  it("requires focusTab's tabId to be a non-negative integer", () => {
    for (const tabId of ["42", 1.5, -1, NaN, Infinity, null, {}]) {
      expect(parseUiRequest({ kite: "ui", op: "focusTab", session: "s", tabId })).toBeNull()
    }
  })
  it("trims and caps the pause reason; blank means none", () => {
    expect(parseUiRequest({ kite: "ui", op: "pause", reason: "  lunch " })).toEqual({ kite: "ui", op: "pause", reason: "lunch" })
    expect(parseUiRequest({ kite: "ui", op: "pause", reason: "   " })).toEqual({ kite: "ui", op: "pause" })
    const long = parseUiRequest({ kite: "ui", op: "pause", reason: "x".repeat(500) })
    expect(long && "reason" in long ? long.reason!.length : 0).toBe(REASON_MAX)
  })
  it("rejects wrong types and unknown ops", () => {
    expect(parseUiRequest({ kite: "ui", op: "pause", reason: 5 })).toBeNull()
    expect(parseUiRequest({ kite: "ui", op: "focusTab", session: 1 })).toBeNull()
    expect(parseUiRequest({ kite: "ui", op: "focusTab" })).toBeNull()
    expect(parseUiRequest({ kite: "ui", op: "openPanel", windowId: "1" })).toBeNull()
    expect(parseUiRequest({ kite: "ui", op: "nuke" })).toBeNull()
    expect(parseUiRequest({ kite: "agent", op: "state" })).toBeNull()
    expect(parseUiRequest(null)).toBeNull()
  })
})
