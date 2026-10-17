import type { ActivityEntry } from "@kitestring/protocol"
import { describe, expect, it } from "vitest"
import { clockTime, describeAction, duration, statusTone, summaryDetail } from "../ui/activity-format"

const entry = (e: Partial<ActivityEntry>): ActivityEntry => ({
  id: 1,
  ts: 0,
  session: "default",
  tabId: 1,
  method: "act.click",
  status: "done",
  ms: 10,
  summary: "",
  ...e,
})

describe("describeAction", () => {
  it("names the verb and target the way a person would", () => {
    expect(describeAction(entry({ method: "act.click", target: '"Save"' }))).toBe('click "Save"')
    expect(describeAction(entry({ method: "act.fill", target: '"Email"' }))).toBe('fill "Email"')
    expect(describeAction(entry({ method: "page.goto", target: "https://example.com/" }))).toBe("goto example.com")
    expect(describeAction(entry({ method: "page.goto", target: "https://example.com/a/b" }))).toBe("goto example.com/a/b")
    expect(describeAction(entry({ method: "tab.new", target: "http://127.0.0.1:5173/serial" }))).toBe("tab.new 127.0.0.1:5173/serial")
    expect(describeAction(entry({ method: "tab.close" }))).toBe("tab.close")
    expect(describeAction(entry({ method: "control.pause" }))).toBe("pause")
    expect(describeAction(entry({ method: "control.resume" }))).toBe("resume")
  })
})

describe("summaryDetail", () => {
  it("drops the status the badge already shows and splits off the diff counts", () => {
    expect(summaryDetail(entry({ status: "done", summary: "✓ done +3/−1" }))).toEqual({ text: "", added: 3, removed: 1 })
    expect(summaryDetail(entry({ status: "not_found", summary: '✗ not_found: no match for "Missing" +0/−0' }))).toEqual({
      text: 'no match for "Missing"',
      added: 0,
      removed: 0,
    })
    expect(summaryDetail(entry({ status: "PAUSED", summary: "✗ PAUSED: lunch" }))).toEqual({ text: "lunch" })
    expect(summaryDetail(entry({ status: "done", summary: "✓ closed" }))).toEqual({ text: "closed" })
    expect(summaryDetail(entry({ status: "blocked", summary: "✗ blocked +0/−2" }))).toEqual({ text: "", added: 0, removed: 2 })
  })
  it("leaves out tab.new's tab id and URL: the action line and details already show the page", () => {
    expect(summaryDetail(entry({ method: "tab.new", status: "done", summary: "✓ tab 4 http://x/" }))).toEqual({ text: "" })
  })
  it("shows only the reason for pause and nothing for resume: the action line says which", () => {
    expect(summaryDetail(entry({ method: "control.pause", status: "done", summary: "✓ paused: lunch +1" }))).toEqual({ text: "lunch +1" })
    expect(summaryDetail(entry({ method: "control.pause", status: "done", summary: "✓ paused" }))).toEqual({ text: "" })
    expect(summaryDetail(entry({ method: "control.resume", status: "done", summary: "✓ resumed" }))).toEqual({ text: "" })
  })
})

describe("statusTone", () => {
  it("is ok for done, paused for PAUSED, fail otherwise", () => {
    expect(statusTone("done")).toBe("ok")
    expect(statusTone("PAUSED")).toBe("paused")
    for (const s of ["blocked", "not_found", "ambiguous", "disabled", "no_effect", "timeout", "error", "NOT_OWNER", "TIMEOUT"] as const) {
      expect(statusTone(s)).toBe("fail")
    }
  })
})

describe("duration and clockTime", () => {
  it("formats milliseconds compactly", () => {
    expect(duration(0)).toBe("0 ms")
    expect(duration(312)).toBe("312 ms")
    expect(duration(1234)).toBe("1.2 s")
    expect(duration(65_000)).toBe("65 s")
  })
  it("shows a 24-hour wall clock", () => {
    const ts = new Date(2026, 9, 18, 9, 5, 7).getTime()
    expect(clockTime(ts)).toBe("09:05:07")
  })
})
