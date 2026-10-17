import { describe, expect, it } from "vitest"
import type { ActionResult } from "@kitestring/protocol"
import { formatResult } from "../src/client/format.js"

const base: ActionResult = { ok: true, status: "done", diff: { added: [], removed: [] }, page: "P" }

describe("formatResult", () => {
  it("prints new tabs for a done result", () => {
    expect(formatResult({ ...base, newTabs: [12, 13] })).toBe("✓ done\n⧉ new tab 12\n⧉ new tab 13\npage: P")
  })
  it("prints errors for any status", () => {
    expect(formatResult({ ...base, errors: ["Email is required"] })).toBe("✓ done\n! Email is required\npage: P")
    expect(
      formatResult({ ...base, ok: false, status: "disabled", detail: "x", errors: ["a", "b"], newTabs: [7] }),
    ).toBe("✗ disabled: x\n⧉ new tab 7\n! a\n! b\npage: P")
  })
  it("omits empty errors and newTabs", () => {
    expect(formatResult({ ...base, errors: [], newTabs: [] })).toBe("✓ done\npage: P")
  })
})

describe("formatActivity", () => {
  it("prints one line per entry, in the given (newest-first) order", async () => {
    const { formatActivity } = await import("../src/client/format.js")
    const ts = new Date(2026, 9, 18, 9, 5, 7).getTime()
    const out = formatActivity([
      { id: 2, ts, session: "codex", tabId: 12, method: "act.click", target: '"Save"', status: "done", ms: 812, summary: "✓ done +1/−0" },
      { id: 1, ts, session: "default", tabId: null, method: "act.press", status: "PAUSED", ms: 1, summary: "✗ PAUSED: Kitestring is paused by the user" },
    ])
    expect(out).toBe(
      [
        '09:05:07  codex  tab 12  act.click "Save"  ✓ done +1/−0  (812 ms)',
        "09:05:07  default  tab -  act.press  ✗ PAUSED: Kitestring is paused by the user  (1 ms)",
      ].join("\n"),
    )
  })
  it("says so when empty", async () => {
    const { formatActivity } = await import("../src/client/format.js")
    expect(formatActivity([])).toBe("no activity yet")
  })
})
