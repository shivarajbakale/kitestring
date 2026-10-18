import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ActionResult } from "@kitestring/protocol"

let store: Record<string, unknown>

beforeEach(() => {
  vi.resetModules()
  store = {}
  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: vi.fn(async (k: string) => (k in store ? { [k]: store[k] } : {})),
        set: vi.fn(async (o: Record<string, unknown>) => Object.assign(store, o)),
      },
    },
  }
})

const entry = (n: number) => ({
  session: "default",
  tabId: 1,
  method: "act.click",
  status: "done" as const,
  ms: n,
  summary: `✓ done +0/−0`,
})

describe("activity", () => {
  it("lists newest first and keeps a ring of 200", async () => {
    const activity = await import("../background/activity")
    await activity.ready()
    for (let i = 0; i < 205; i++) activity.record(entry(i))
    const all = activity.list()
    expect(all).toHaveLength(200)
    expect(all[0]!.ms).toBe(204)
    expect(all[199]!.ms).toBe(5)
    expect(all[0]!.id).toBeGreaterThan(all[1]!.id)
    expect(activity.list(3).map((e) => e.ms)).toEqual([204, 203, 202])
    await activity.flush()
    expect((store.activity as unknown[]).length).toBe(200)
  })

  it("reloads persisted entries and continues ids after a restart", async () => {
    store.activity = [{ ...entry(1), id: 41, ts: 1 }]
    const activity = await import("../background/activity")
    await activity.ready()
    const e = activity.record(entry(2))
    expect(e.id).toBe(42)
    expect(activity.list().map((x) => x.id)).toEqual([42, 41])
  })

  it("caps stored diff lines and page brief", async () => {
    const activity = await import("../background/activity")
    await activity.ready()
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const e = activity.record({ ...entry(1), diff: { added: lines, removed: lines }, page: "x".repeat(5000) })
    expect(e.diff!.added).toHaveLength(20)
    expect(e.diff!.removed).toHaveLength(20)
    expect(e.page).toHaveLength(2000)
  })
})

describe("summaries", () => {
  const r: ActionResult = { ok: true, status: "done", diff: { added: ["a", "b"], removed: ["c"] }, page: "P" }
  it("summarizes an action result with diff counts", async () => {
    const { resultSummary } = await import("../background/activity")
    expect(resultSummary(r)).toBe("✓ done +2/−1")
    expect(resultSummary({ ...r, ok: false, status: "blocked", detail: "covered by dialog", diff: { added: [], removed: [] } })).toBe(
      "✗ blocked: covered by dialog +0/−0",
    )
  })
  it("summarizes an RPC error without repeating the code", async () => {
    const { errorSummary } = await import("../background/activity")
    expect(errorSummary("NOT_OWNER", "NOT_OWNER: tab 3 does not belong")).toBe("✗ NOT_OWNER: tab 3 does not belong")
    expect(errorSummary("PAUSED", "Kitestring is paused by the user")).toBe("✗ PAUSED: Kitestring is paused by the user")
  })
  it("summarizes pause (with its reason) and resume", async () => {
    const { controlSummary, record, list } = await import("../background/activity")
    expect(controlSummary("control.pause", "lunch")).toBe("✓ paused: lunch")
    expect(controlSummary("control.pause")).toBe("✓ paused")
    expect(controlSummary("control.resume")).toBe("✓ resumed")
    record({ session: "default", tabId: null, method: "control.pause", status: "done", ms: 1, summary: controlSummary("control.pause", "lunch") })
    expect(list(1)[0]).toMatchObject({ method: "control.pause", status: "done", tabId: null, summary: "✓ paused: lunch" })
  })

  it("redacts filled values in stored diffs and the page brief, keeping the rest of each line", async () => {
    const activity = await import("../background/activity")
    await activity.ready()
    const e = activity.record({
      ...entry(1),
      diff: {
        added: ['textbox "Email" value="ada@x.io" [@e00002]', 'textbox "Note" value="say \\"hi\\" there" [@e00003]', 'button "Save" [@e00004]'],
        removed: ['textbox "Email" value="" [@e00002]'],
      },
      page: 'form: textbox "Card" value="4242 4242 4242 4242"',
    })
    expect(e.diff).toEqual({
      added: ['textbox "Email" value=(redacted) [@e00002]', 'textbox "Note" value=(redacted) [@e00003]', 'button "Save" [@e00004]'],
      removed: ['textbox "Email" value=(redacted) [@e00002]'],
    })
    expect(e.page).toBe('form: textbox "Card" value=(redacted)')
    await activity.flush()
    expect(JSON.stringify(store.activity)).not.toContain("ada@x.io")
    expect(JSON.stringify(store.activity)).not.toContain("4242")
  })
})
