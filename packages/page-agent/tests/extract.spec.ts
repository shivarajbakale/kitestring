import { test, expect } from "./harness"

type Result = { key: string; source: string; columns: string[]; rows: Record<string, string>[]; total: number; others: { index: number; key: string }[] }
type W = Window & { __kiteAgent: { extract(opts?: object): Result } }

test("the product cards are the best candidate, one row each with aligned columns", async ({ fixture }) => {
  const page = await fixture("extract.html")
  const r = await page.evaluate(() => (window as unknown as W).__kiteAgent.extract())
  expect(r.key).toBe("list:div>div.card.product")
  expect(r.total).toBe(4)
  expect(r.columns).toEqual(["link", "image", "title", "price", "rating"])
  expect(r.rows[0]).toMatchObject({ title: "Blue kettle", price: "₹1,299", rating: "4.5" })
  expect(r.rows[0]!.link).toMatch(/\/p\/1$/)
  expect(r.rows[2]).not.toHaveProperty("rating")
  expect(r.rows.map((x) => x.title)).not.toContain("Hidden")
  expect(r.others.some((o) => o.key.startsWith("table:"))).toBe(true)
})

test("near picks the table holding the text; headers become columns and the row link is kept", async ({ fixture }) => {
  const page = await fixture("extract.html")
  const r = await page.evaluate(() => (window as unknown as W).__kiteAgent.extract({ near: "#101" }))
  expect(r.key).toBe("table:Order|Date|Total")
  expect(r.columns).toEqual(["Order", "Date", "Total", "link"])
  expect(r.rows).toHaveLength(2)
  expect(r.rows[1]).toMatchObject({ Order: "#101", Date: "2026-10-05", Total: "₹399" })
  expect(r.rows[1]!.link).toMatch(/\/o\/101$/)
})

test("selector and max", async ({ fixture }) => {
  const page = await fixture("extract.html")
  const r = await page.evaluate(() => (window as unknown as W).__kiteAgent.extract({ selector: "#results .card", max: 2 }))
  expect(r.rows).toHaveLength(2)
  expect(r.total).toBe(4)
  expect(r.key).toBe("css:#results .card")
})

test("key finds the same list after the page changes", async ({ fixture }) => {
  const page = await fixture("extract.html")
  const first = await page.evaluate(() => (window as unknown as W).__kiteAgent.extract())
  await page.click("#next")
  const r = await page.evaluate((key) => (window as unknown as W).__kiteAgent.extract({ key }), first.key)
  expect(r.rows.map((x) => x.title)).toEqual(["Wool scarf", "Cotton cap", "Silk tie"])
})

test("errors: bad selector, near text nowhere", async ({ fixture }) => {
  const page = await fixture("extract.html")
  await expect(page.evaluate(() => (window as unknown as W).__kiteAgent.extract({ selector: "[[" }))).rejects.toThrow(/not a valid CSS selector/)
  await expect(page.evaluate(() => (window as unknown as W).__kiteAgent.extract({ near: "zzz nowhere" }))).rejects.toThrow(/no table or repeated list holds/)
})
