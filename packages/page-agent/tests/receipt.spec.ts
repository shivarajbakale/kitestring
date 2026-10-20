import { test, expect } from "./harness"

interface Agent {
  find(t: { text: string }, intent: "click"): { kind: string; ref: string }
  armClick(ref: string): Promise<{ kind: string; x?: number; y?: number }>
  clickReceipt(disarm: boolean): { received: boolean; mutations: number; connected: boolean; landedOn?: string } | null
}
type W = { __kiteAgent: Agent }
const ref = (page: import("@playwright/test").Page, text: string) =>
  page.evaluate((t) => (window as unknown as W).__kiteAgent.find({ text: t }, "click").ref, text)
const arm = (page: import("@playwright/test").Page, r: string) => page.evaluate((x) => (window as unknown as W).__kiteAgent.armClick(x), r)
const receipt = (page: import("@playwright/test").Page, disarm = true) =>
  page.evaluate((d) => (window as unknown as W).__kiteAgent.clickReceipt(d), disarm)

test("a click on the armed element is received, and its effect counts as mutations", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  const a = await arm(page, await ref(page, "Go"))
  expect(a.kind).toBe("ok")
  await page.mouse.click(a.x!, a.y!)
  expect(await receipt(page)).toMatchObject({ received: true, connected: true })
  expect((await receipt(page)) === null).toBe(true) // disarmed
})

test("a click with no effect is received with no mutations", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  const a = await arm(page, await ref(page, "Quiet"))
  await page.mouse.click(a.x!, a.y!)
  expect(await receipt(page)).toEqual({ received: true, mutations: 0, connected: true })
})

test("an element removed after arming does not receive the click, and the press hit no control", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  const a = await arm(page, await ref(page, "Quiet"))
  await page.evaluate(() => document.getElementById("quiet")!.remove())
  await page.mouse.click(a.x!, a.y!)
  const r = await receipt(page)
  expect(r).toMatchObject({ received: false, connected: false })
  expect(r!.landedOn).toBeUndefined()
})

test("a twin re-rendered in its place (same role and name) counts as received", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  const a = await arm(page, await ref(page, "Quiet"))
  await page.evaluate(() => {
    const old = document.getElementById("quiet")!
    old.replaceWith(old.cloneNode(true))
  })
  await page.mouse.click(a.x!, a.y!)
  expect(await receipt(page)).toMatchObject({ received: true, connected: false })
})

test("a different control in its place is named: the press may have done something", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  const a = await arm(page, await ref(page, "Quiet"))
  await page.evaluate(() => {
    const b = document.createElement("button")
    b.textContent = "Cancel order"
    document.getElementById("quiet")!.replaceWith(b)
  })
  await page.mouse.click(a.x!, a.y!)
  expect(await receipt(page)).toMatchObject({ received: false, landedOn: 'button "Cancel order"' })
})

test("a moving element is reported as moving, not clicked", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  await page.evaluate(() => (document.getElementById("slide")!.style.left = "300px"))
  await page.waitForTimeout(50)
  expect((await arm(page, await ref(page, "Slide"))).kind).toBe("moving")
})

test("a detached or covered element is not armed", async ({ fixture }) => {
  const page = await fixture("receipt.html")
  const r = await ref(page, "Go")
  await page.evaluate(() => {
    const cover = document.createElement("div")
    cover.style.cssText = "position:fixed;inset:0;background:#fff"
    document.body.appendChild(cover)
  })
  expect((await arm(page, r)).kind).toBe("blocked")
  await page.evaluate(() => document.getElementById("go")!.remove())
  expect((await arm(page, r)).kind).toBe("gone")
})
