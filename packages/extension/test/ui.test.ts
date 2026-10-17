import { describe, expect, it } from "vitest"
import type { ActivityEntry } from "@kitestring/protocol"
import { relativeTime } from "../ui/components/RelativeTime"
import { describeAction } from "../ui/components/SessionList"

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
