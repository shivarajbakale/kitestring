import { test, expect } from "./harness"

type Loc = { ref: string; role: string; name: string; landmarkPath: string[]; cssPath: string; nth: number }
type FR = { kind: "found"; ref: string; locator?: Loc; hinted: boolean; secret?: true } | { kind: "ambiguous" } | { kind: "not_found" }
interface Agent {
  find(t: { text: string; role?: string }, intent: "click" | "fill" | "select", hint?: Loc): FR
  resolve(ref: string): Element | null
}
type W = { __kiteAgent: Agent; rerender(): void; asLink(): void; rename(): void; addSaveBefore(): void }
async function locate(page: import("@playwright/test").Page, text: string, intent: "click" | "fill" = "click"): Promise<Loc> {
  return page.evaluate(([t, i]) => {
    const f = (window as unknown as W).__kiteAgent.find({ text: t }, i as "click" | "fill")
    if (f.kind !== "found") throw new Error(f.kind)
    return f.locator!
  }, [text, intent] as const)
}

test("describeLocator captures role, name, landmarks and a css path", async ({ fixture }) => {
  const page = await fixture("locator.html")
  const loc = await locate(page, "Save")
  expect(loc).toMatchObject({ role: "button", name: "Save", landmarkPath: ["main", "Profile"], nth: 0 })
  expect(await page.evaluate((p) => document.querySelector(p)?.id, loc.cssPath)).toBe("save")
})

test("hint resolves after a re-render with the same content", async ({ fixture }) => {
  const page = await fixture("locator.html")
  const loc = await locate(page, "Save")
  await page.evaluate(() => (window as unknown as W).rerender())
  const r = await page.evaluate((l) => {
    const f = (window as unknown as W).__kiteAgent.find({ text: "Save" }, "click", l)
    return f.kind === "found" ? { hinted: f.hinted, id: (window as unknown as W).__kiteAgent.resolve(f.ref)?.id } : f.kind
  }, loc)
  expect(r).toEqual({ hinted: true, id: "save" })
})

test("hint is rejected when the role changed", async ({ fixture }) => {
  const page = await fixture("locator.html")
  const loc = await locate(page, "Save")
  await page.evaluate(() => (window as unknown as W).asLink())
  const r = await page.evaluate((l) => {
    const f = (window as unknown as W).__kiteAgent.find({ text: "Save" }, "click", l)
    return f.kind === "found" ? { hinted: f.hinted, role: f.locator!.role } : f.kind
  }, loc)
  expect(r).toEqual({ hinted: false, role: "link" })
})

test("hint is rejected when the name no longer scores 70", async ({ fixture }) => {
  const page = await fixture("locator.html")
  const loc = await locate(page, "Save")
  await page.evaluate(() => (window as unknown as W).rename())
  const r = await page.evaluate((l) => {
    const a = (window as unknown as W).__kiteAgent
    const f = a.find({ text: "Save" }, "click", l)
    return f.kind === "found" ? { hinted: f.hinted, id: a.resolve(f.ref)?.id } : f.kind
  }, loc)
  // the renamed button is gone from the results; the normal search lands on "Save draft"
  expect(r).toEqual({ hinted: false, id: "draft" })
})

test("a hint for another element is not used when the target asks for a different name", async ({ fixture }) => {
  const page = await fixture("locator.html")
  const loc = await locate(page, "Save")
  const r = await page.evaluate((l) => {
    const f = (window as unknown as W).__kiteAgent.find({ text: "Email" }, "fill", l)
    return f.kind === "found" ? f.hinted : f.kind
  }, loc)
  expect(r).toBe(false)
})

test("password and card fields are flagged secret; plain ones are not", async ({ fixture }) => {
  const page = await fixture("locator.html")
  const secret = (t: string) =>
    page.evaluate((t) => {
      const f = (window as unknown as W).__kiteAgent.find({ text: t }, "fill")
      return f.kind === "found" ? !!f.secret : f.kind
    }, t)
  expect(await secret("Password")).toBe(true)
  expect(await secret("Card")).toBe(true)
  expect(await secret("Email")).toBe(false)
})

test("a second same-named button added before the cached one makes the find ambiguous, never hinted", async ({ fixture }) => {
  const page = await fixture("locator.html")
  const loc = await locate(page, "Save")
  await page.evaluate(() => (window as unknown as W).addSaveBefore())
  const r = await page.evaluate((l) => {
    const f = (window as unknown as W).__kiteAgent.find({ text: "Save" }, "click", l)
    return f.kind === "found" ? { kind: f.kind, hinted: f.hinted } : { kind: f.kind }
  }, loc)
  expect(r).toEqual({ kind: "ambiguous" })
})

test("a better match wins over a hint that still scores 70 or more", async ({ fixture }) => {
  const page = await fixture("locator.html")
  const draft = await locate(page, "Save draft")
  const r = await page.evaluate((l) => {
    const a = (window as unknown as W).__kiteAgent
    const f = a.find({ text: "Save" }, "click", l)
    return f.kind === "found" ? { hinted: f.hinted, id: a.resolve(f.ref)?.id } : f.kind
  }, draft)
  expect(r).toEqual({ hinted: false, id: "save" })
})
