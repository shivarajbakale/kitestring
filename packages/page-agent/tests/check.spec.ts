import { test, expect } from "./harness"

type CR =
  | { kind: "ok"; x: number; y: number }
  | { kind: "blocked"; by: string }
  | { kind: "disabled"; errors: string[] }
  | { kind: "hidden" }
interface Agent {
  check(ref: string): CR
  find(t: { text: string }, intent: "click" | "fill" | "select"): { kind: string; ref: string }
  readValue(ref: string): string | null
  setSelect(ref: string, value: string): boolean
  brief(): string
}

async function refOf(page: import("@playwright/test").Page, text: string): Promise<string> {
  return page.evaluate((t) => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.find({ text: t }, "click").ref, text)
}

test("visible button is ok with centre inside the viewport", async ({ fixture }) => {
  const page = await fixture("check.html")
  const ref = await refOf(page, "Plain")
  const r = await page.evaluate((x) => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.check(x), ref)
  expect(r.kind).toBe("ok")
  const ok = r as { x: number; y: number }
  expect(ok.x).toBeGreaterThan(0)
  expect(ok.y).toBeGreaterThan(0)
})

test("scrolls far element into view", async ({ fixture }) => {
  const page = await fixture("check.html")
  const ref = await refOf(page, "Far away")
  const r = await page.evaluate((x) => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.check(x), ref)
  expect(r.kind).toBe("ok")
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
})

test("display:none and visibility:hidden are hidden; unknown ref hidden", async ({ fixture }) => {
  const page = await fixture("check.html")
  const out = await page.evaluate(() => {
    const a = (window as unknown as { __kiteAgent: Agent }).__kiteAgent
    const res: Record<string, string> = {}
    for (const [id, text, prop, hiddenVal] of [
      ["gone", "Gone", "display", "none"],
      ["invisible", "Invisible", "visibility", "hidden"]
    ]) {
      const el = document.getElementById(id)!
      el.style.setProperty("display", "block")
      el.style.setProperty("visibility", "visible")
      const ref = a.find({ text }, "click").ref
      el.style.setProperty(prop, hiddenVal)
      res[id] = a.check(ref).kind
    }
    res.unknown = a.check("@e00000").kind
    return res
  })
  expect(out).toEqual({ gone: "hidden", invisible: "hidden", unknown: "hidden" })
})

test("covering dialog blocks and is described", async ({ fixture }) => {
  const page = await fixture("check.html")
  const ref = await refOf(page, "Plain")
  await page.evaluate(() => (document.getElementById("cover")!.style.display = "block"))
  const r = await page.evaluate((x) => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.check(x), ref)
  expect(r.kind).toBe("blocked")
  expect((r as { by: string }).by).toContain('dialog "Cookie consent"')
})

test("anonymous full-screen cover falls back to tag and id", async ({ fixture }) => {
  const page = await fixture("check.html")
  const ref = await refOf(page, "Plain")
  await page.evaluate(() => (document.getElementById("plaincover")!.style.display = "block"))
  const r = await page.evaluate((x) => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.check(x), ref)
  expect(r).toEqual({ kind: "blocked", by: "<div>#plaincover" })
})

test("disabled submit reports page errors", async ({ fixture }) => {
  const page = await fixture("check.html")
  const ref = await refOf(page, "Submit")
  const r = await page.evaluate((x) => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.check(x), ref)
  expect(r.kind).toBe("disabled")
  expect((r as { errors: string[] }).errors).toEqual(["Enter a valid email"])
})

test("aria-disabled is disabled", async ({ fixture }) => {
  const page = await fixture("check.html")
  const ref = await refOf(page, "Aria off")
  const r = await page.evaluate((x) => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.check(x), ref)
  expect(r.kind).toBe("disabled")
})

test("readValue and setSelect", async ({ fixture }) => {
  const page = await fixture("check.html")
  const out = await page.evaluate(() => {
    const a = (window as unknown as { __kiteAgent: Agent }).__kiteAgent
    const name = a.find({ text: "Name" }, "fill").ref
    const note = a.find({ text: "Note" }, "fill").ref
    const sel = a.find({ text: "Colour" }, "select").ref
    const events: string[] = []
    const s = document.getElementById("sel") as HTMLSelectElement
    s.addEventListener("input", () => events.push("input"))
    s.addEventListener("change", () => events.push("change"))
    return {
      name: a.readValue(name),
      note: a.readValue(note),
      missing: a.readValue("@e00000"),
      byLabel: a.setSelect(sel, "  green APPLE "),
      value: s.value,
      byValue: a.setSelect(sel, "r"),
      value2: s.value,
      none: a.setSelect(sel, "blue"),
      notSelect: a.setSelect(name, "x"),
      events
    }
  })
  expect(out).toEqual({
    name: "Ann", note: "hello", missing: null, byLabel: true, value: "g", byValue: true, value2: "r",
    none: false, notSelect: false, events: ["input", "change", "input", "change"]
  })
})

test("brief summarises the page", async ({ fixture }) => {
  const page = await fixture("check.html")
  const b = await page.evaluate(() => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.brief())
  expect(b).toMatch(/^Check page \| file:\/\/.*check\.html \| Check \| \d+ interactive$/)
})

test("smooth-scroll pages are measured after an instant scroll", async ({ fixture }) => {
  const page = await fixture("smooth.html")
  const ref = await refOf(page, "Target")
  const r = await page.evaluate((x) => {
    const c = (window as unknown as { __kiteAgent: Agent }).__kiteAgent.check(x)
    const hit = c.kind === "ok" ? document.elementFromPoint(c.x, c.y)?.id : null
    return { c, hit, h: window.innerHeight }
  }, ref)
  expect(r.c.kind).toBe("ok")
  expect((r.c as { y: number }).y).toBeGreaterThan(0)
  expect((r.c as { y: number }).y).toBeLessThan(r.h)
  expect(r.hit).toBe("target")
})

test("page-level alerts count, aria-live=off does not", async ({ fixture }) => {
  const page = await fixture("errors.html")
  const ref = await refOf(page, "Send")
  const r = await page.evaluate((x) => (window as unknown as { __kiteAgent: Agent }).__kiteAgent.check(x), ref)
  expect(r.kind).toBe("disabled")
  expect((r as { errors: string[] }).errors).toEqual(["Server is down", "Saved draft"])
})

test("readValue is null for non-editable; setSelect skips disabled options", async ({ fixture }) => {
  const page = await fixture("errors.html")
  const out = await page.evaluate(() => {
    const a = (window as unknown as { __kiteAgent: Agent }).__kiteAgent
    const btn = a.find({ text: "Btn" }, "click").ref
    const sel = a.find({ text: "Pick" }, "select").ref
    return { btn: a.readValue(btn), dis: a.setSelect(sel, "b"), ok: a.setSelect(sel, "a") }
  })
  expect(out).toEqual({ btn: null, dis: false, ok: true })
})
