import { test, expect } from "./harness"

interface Closer {
  ref: string
  line: string
  kind: "cookie" | "newsletter"
}
interface Agent {
  find(t: { text: string }, intent: "click"): { ref: string }
  closerFor(ref: string): Closer | null
}

async function closerWith(page: import("@playwright/test").Page, overlayId: string): Promise<Closer | null> {
  return page.evaluate((id) => {
    document.getElementById(id)!.style.display = "block"
    const a = (window as unknown as { __kiteAgent: Agent }).__kiteAgent
    return a.closerFor(a.find({ text: "Continue" }, "click").ref)
  }, overlayId)
}

test("OneTrust banner: prefers Reject all", async ({ fixture }) => {
  const page = await fixture("popups.html")
  const c = await closerWith(page, "onetrust-banner-sdk")
  expect(c?.kind).toBe("cookie")
  expect(c?.line).toContain('"Reject all"')
})

test("banner with only Accept: Accept", async ({ fixture }) => {
  const page = await fixture("popups.html")
  const c = await closerWith(page, "only-accept")
  expect(c?.kind).toBe("cookie")
  expect(c?.line).toContain('"Accept"')
})

test("newsletter modal: Close, never Subscribe", async ({ fixture }) => {
  const page = await fixture("popups.html")
  const c = await closerWith(page, "newsletter")
  expect(c?.kind).toBe("newsletter")
  expect(c?.line).toContain('"Close"')
})

test("unrelated fixed cover is left alone", async ({ fixture }) => {
  const page = await fixture("popups.html")
  expect(await closerWith(page, "maintenance")).toBeNull()
})

test("banner whose only button is risky is left alone", async ({ fixture }) => {
  const page = await fixture("popups.html")
  expect(await closerWith(page, "risky")).toBeNull()
})

test("nothing covering: null", async ({ fixture }) => {
  const page = await fixture("popups.html")
  const c = await page.evaluate(() => {
    const a = (window as unknown as { __kiteAgent: Agent }).__kiteAgent
    return a.closerFor(a.find({ text: "Continue" }, "click").ref)
  })
  expect(c).toBeNull()
})

test("a page-wide wrapper with a cookie class around the target is not a cookie banner", async ({ fixture }) => {
  const page = await fixture("popups-wrapper.html")
  const c = await page.evaluate(() => {
    const a = (window as unknown as { __kiteAgent: Agent }).__kiteAgent
    return a.closerFor(a.find({ text: "Continue" }, "click").ref)
  })
  expect(c).toBeNull()
})

test("generic (non-CMP) cookie banner by class: Reject", async ({ fixture }) => {
  const page = await fixture("popups.html")
  const c = await closerWith(page, "generic-cookie")
  expect(c?.kind).toBe("cookie")
  expect(c?.line).toContain('"Reject"')
})

test("a consent overlay that never mentions cookies: no Agree fallback", async ({ fixture }) => {
  const page = await fixture("popups.html")
  expect(await closerWith(page, "terms-consent")).toBeNull()
})

test('newsletter shell: "Close account" / "Dismiss review" are never picked', async ({ fixture }) => {
  const page = await fixture("popups.html")
  expect(await closerWith(page, "close-account")).toBeNull()
})

test("newsletter names match in preference order: Close before No thanks", async ({ fixture }) => {
  const page = await fixture("popups.html")
  const c = await closerWith(page, "news-order")
  expect(c?.kind).toBe("newsletter")
  expect(c?.line).toContain('"Close"')
})

test("a native modal <dialog> newsletter: No, thanks", async ({ fixture }) => {
  const page = await fixture("popups.html")
  const c = await page.evaluate(() => {
    ;(document.getElementById("news-dialog") as HTMLDialogElement).showModal()
    const a = (window as unknown as { __kiteAgent: Agent }).__kiteAgent
    return a.closerFor(a.find({ text: "Continue" }, "click").ref)
  })
  expect(c?.kind).toBe("newsletter")
  expect(c?.line).toContain('"No, thanks"')
})
