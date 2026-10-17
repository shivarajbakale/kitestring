import type { Page } from "@playwright/test"
import { expect, test, type KiteRun } from "./fixtures"

const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr
const DONE = /^✓ done$/m

const events = (page: Page) => page.evaluate(() => (window as unknown as { __events: string[] }).__events)

async function openSerial(kite: (...a: string[]) => Promise<KiteRun>, context: import("@playwright/test").BrowserContext, torture: string) {
  const url = `${torture}/serial`
  const r = await kite("tab", "new", url)
  expect(r.code, out(r)).toBe(0)
  const page = context.pages().find((p) => p.url() === url)
  if (!page) throw new Error(`no page for ${url}`)
  return page
}

/**
 * Starts `kite click "Slow task"` and resolves once the click has landed on the page. The pending
 * run is wrapped: an async function returning a bare promise would wait for it.
 */
async function startSlow(kite: (...a: string[]) => Promise<KiteRun>, page: Page): Promise<{ run: Promise<KiteRun> }> {
  const run = kite("click", "Slow task")
  await expect.poll(() => events(page), { timeout: 10_000, intervals: [50] }).toContain("slow:start")
  return { run }
}

test.describe("per-tab serialization (Review Focus 5)", () => {
  test("two concurrent clicks on the same tab never interleave", async ({ kite, context, torture }) => {
    const page = await openSerial(kite, context, torture)
    const slow = (await startSlow(kite, page)).run
    const fast = kite("click", "Fast task")
    const [s, f] = await Promise.all([slow, fast])
    expect(out(s)).toMatch(DONE)
    expect(out(f)).toMatch(DONE)
    expect(await events(page)).toEqual(["slow:start", "slow:end", "fast"])
    expect(s.code).toBe(0)
    expect(f.code).toBe(0)
  })
})

test.describe("pause switch (Review Focus 4)", () => {
  test("in-flight action finishes, queued and new requests get PAUSED, resume restores", async ({ kite, context, torture }) => {
    const page = await openSerial(kite, context, torture)
    const slow = (await startSlow(kite, page)).run
    let slowDone = false
    void slow.then(() => (slowDone = true))
    const queued = kite("click", "Fast task") // waits for the slow click's tab lock
    await new Promise((r) => setTimeout(r, 300))

    const p = await kite("pause", "lunch")
    expect(p.code, out(p)).toBe(0)

    const q = await queued
    expect(q.code).toBe(1)
    expect(out(q)).toContain("PAUSED")
    expect(slowDone).toBe(false) // the waiter was rejected right away, not after the holder finished

    const t0 = Date.now()
    const n = await kite("click", "Fast task")
    expect(n.code).toBe(1)
    expect(out(n)).toContain("PAUSED")
    expect(out(n)).toContain("Kitestring is paused by the user")
    expect(Date.now() - t0).toBeLessThan(1000)

    const s = await slow
    expect(out(s)).toMatch(DONE)
    expect(s.code).toBe(0)
    expect(await events(page)).toEqual(["slow:start", "slow:end"])

    const st = await kite("status", "--json")
    expect(JSON.parse(st.stdout)).toMatchObject({ connected: true, paused: true })

    expect((await kite("resume")).code).toBe(0)
    const again = await kite("click", "Fast task")
    expect(out(again)).toMatch(DONE)
    expect(again.code).toBe(0)
    expect(await events(page)).toEqual(["slow:start", "slow:end", "fast"])
    expect(JSON.parse((await kite("status", "--json")).stdout).paused).toBe(false)
  })

  test("pause state persists in chrome.storage.session; a paused tab.new creates nothing", async ({ kite, kiteEnv, torture, sw }) => {
    expect((await kite("pause")).code).toBe(0)
    const stored = await sw.evaluate(() => chrome.storage.session.get("control"))
    expect(stored.control).toMatchObject({ paused: true })
    const t = await kiteEnv({ KITE_SESSION: "late" }, "tab", "new", `${torture}/serial`)
    expect(t.code).toBe(1)
    expect(out(t)).toContain("PAUSED")
    expect(JSON.parse((await kite("status", "--json")).stdout).sessions).toEqual([])
    const json = JSON.parse((await kite("activity", "--json")).stdout)
    expect(json.entries[0]).toMatchObject({ session: "late", method: "tab.new", status: "PAUSED", tabId: null })
    expect((await kite("resume")).code).toBe(0)
    const after = await sw.evaluate(() => chrome.storage.session.get("control"))
    expect(after.control).toMatchObject({ paused: false })
  })
})

test.describe("activity log", () => {
  test("lists recorded actions newest first with summaries", async ({ kite, context, torture, sw }) => {
    await openSerial(kite, context, torture)
    expect(out(await kite("click", "Fast task"))).toMatch(DONE)
    await kite("pause")
    await kite("click", "Fast task")
    await kite("resume")
    await kite("snapshot") // reads are not recorded

    const r = await kite("activity")
    expect(r.code, out(r)).toBe(0)
    const lines = r.stdout.trim().split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/act\.click "Fast task"\s+✗ PAUSED: Kitestring is paused by the user/)
    expect(lines[1]).toMatch(/act\.click "Fast task"\s+✓ done \+\d+\/−\d+/)
    expect(lines[2]).toMatch(/tab\.new .*serial/)

    const json = JSON.parse((await kite("activity", "--json", "--limit", "1")).stdout)
    expect(json.entries).toHaveLength(1)
    expect(json.entries[0]).toMatchObject({ method: "act.click", status: "PAUSED", session: "default" })

    const stored = await sw.evaluate(() => chrome.storage.session.get("activity"))
    expect((stored.activity as { method: string }[]).map((e) => e.method)).toEqual(["tab.new", "act.click", "act.click"])
  })
})

test.describe("R14", () => {
  test("an action on a page that never becomes scriptable answers ✗ timeout, not an RPC error", async ({ kiteEnv, torture }) => {
    const env = { KITE_TIMEOUT_MS: "40000" }
    expect((await kiteEnv(env, "tab", "new", `${torture}/hang`)).code).toBe(0)
    const r = await kiteEnv(env, "click", "Anything")
    expect(r.stdout).toMatch(/^✗ timeout: /m)
    expect(r.stderr).not.toContain("TIMEOUT")
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(17_000)
  })
})
