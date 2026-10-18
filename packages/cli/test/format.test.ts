import { describe, expect, it } from "vitest"
import type { ActionResult, BatchResult } from "@kitestring/protocol"
import { formatBatch, formatConsole, formatNetwork, formatResult } from "../src/client/format.js"

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
  it("prints one line per dialog", () => {
    expect(
      formatResult({ ...base, dialogs: [{ type: "alert", message: "Hello", handled: "accepted" }, { type: "confirm", message: "Sure?", handled: "dismissed" }] }),
    ).toBe('✓ done\n! dialog alert "Hello" accepted\n! dialog confirm "Sure?" dismissed\npage: P')
  })
  it("prints one line per closed popup", () => {
    expect(formatResult({ ...base, closedPopups: ['cookie "Reject all"'] })).toBe('✓ done\n⨯ closed popup cookie "Reject all"\npage: P')
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

describe("formatConsole / formatNetwork", () => {
  it("prints [level] text (file:line)", () => {
    expect(formatConsole([{ ts: 1, level: "error", text: "kaboom", url: "https://s.test/js/app.js", line: 12, nav: 0 }])).toBe(
      "[error] kaboom (app.js:12)",
    )
    expect(formatConsole([{ ts: 1, level: "log", text: "hi", nav: 0 }])).toBe("[log] hi")
    expect(formatConsole([])).toBe("no console entries")
  })
  it("prints only the first line of a multi-line exception", () => {
    expect(
      formatConsole([{ ts: 1, level: "error", text: "Uncaught Error: kaboom\n    at f (app.js:12:9)\n    at g", url: "https://s.test/app.js", line: 12, nav: 0 }]),
    ).toBe("[error] Error: kaboom (app.js:12)")
  })
  it("prints METHOD status url (ms)", () => {
    expect(
      formatNetwork([
        { ts: 1, method: "GET", url: "https://s.test/status/500", status: 500, type: "Fetch", ms: 34, failed: true, nav: 0 },
        { ts: 1, method: "GET", url: "https://s.test/x", type: "Fetch", failed: true, error: "net::ERR_FAILED", nav: 0 },
      ]),
    ).toBe("GET 500 https://s.test/status/500 (34 ms)\nGET ERR https://s.test/x net::ERR_FAILED")
  })
})

describe("formatBatch", () => {
  const empty = { added: [], removed: [] }
  it("ok: one line per step, skipped marked, diff and page", () => {
    const r: BatchResult = {
      ok: true,
      steps: [
        { i: 0, action: "fill", target: '"Name"', status: "done", ms: 10, resolved: { role: "textbox", name: "Name" } },
        { i: 1, action: "click", target: '"Accept cookies"', status: "skipped", ms: 1 },
        { i: 2, action: "press", status: "no_effect", ms: 3 },
      ],
      diff: { added: ["button Saved"], removed: ["button Save"] },
      closedPopups: ['cookie "Reject all"'],
      page: "Page",
    }
    expect(formatBatch(r)).toBe(
      ['✓ 1 fill "Name"', '· 2 skipped "Accept cookies"', "✓ 3 press", '⨯ closed popup cookie "Reject all"', "+ button Saved", "- button Save", "page: Page"].join("\n"),
    )
  })
  it("halted risky: reason, resume hint, candidates", () => {
    const r: BatchResult = {
      ok: false,
      steps: [
        { i: 0, action: "fill", target: '"Name"', status: "done", ms: 10 },
        { i: 1, action: "click", target: '"Pay"', status: "blocked", detail: "risky", ms: 2 },
      ],
      halted: { index: 1, reason: "risky", detail: 'refusing to click "Pay" in a batch' },
      next: 1,
      diff: empty,
      page: "Checkout",
    }
    expect(formatBatch(r)).toBe(
      [
        '✓ 1 fill "Name"',
        '✗ 2 click "Pay": risky',
        'halted at step 2 (risky): refusing to click "Pay" in a batch',
        "resume with steps from 2",
        "page: Checkout",
      ].join("\n"),
    )
  })
  it("halted time: dialogs, new tabs, no detail on the step", () => {
    const r: BatchResult = {
      ok: false,
      steps: [{ i: 0, action: "click", target: '"Next"', status: "timeout", ms: 14000 }],
      halted: { index: 0, reason: "time" },
      next: 0,
      newTabs: [5],
      dialogs: [{ type: "confirm", message: "Sure?", handled: "dismissed" }],
      diff: empty,
      page: "P",
    }
    expect(formatBatch(r)).toBe(
      ['✗ 1 click "Next": timeout', "halted at step 1 (time)", "resume with steps from 1", '! dialog confirm "Sure?" dismissed', "⧉ new tab 5", "page: P"].join("\n"),
    )
  })
  it("halted without next has no resume line", () => {
    const r: BatchResult = { ok: false, steps: [], halted: { index: 0, reason: "paused", detail: "x" }, diff: empty, page: "P" }
    expect(formatBatch(r)).toBe("halted at step 1 (paused): x\npage: P")
  })
  it("does not print the internal resolved target", () => {
    const r: BatchResult = {
      ok: true,
      steps: [{ i: 0, action: "click", target: '"Go"', status: "done", ms: 1, resolved: { role: "button", name: "SECRETNAME" } }],
      diff: empty,
      page: "P",
    }
    expect(formatBatch(r)).not.toContain("SECRETNAME")
  })
})
