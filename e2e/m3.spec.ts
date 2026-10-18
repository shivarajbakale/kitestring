import { expect, test } from "./fixtures"

const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr

test.describe("alert guard", () => {
  test("alert is accepted and reported; the action does not hang", async ({ kite, context, torture }) => {
    const url = `${torture}/alert-box`
    expect((await kite("tab", "new", url)).code).toBe(0)
    const t0 = Date.now()
    const r = await kite("click", "Show alert")
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(out(r)).toMatch(/^✓ done$/m)
    expect(out(r)).toContain('dialog alert "Hello" accepted')
    const page = context.pages().find((p) => p.url() === url)!
    expect(await page.evaluate(() => (window as unknown as { __step1?: boolean }).__step1)).toBe(true)
  })

  test("confirm is dismissed by default", async ({ kite, context, torture, result }) => {
    const url = `${torture}/alert-box`
    await kite("tab", "new", url)
    const r = await kite("click", "Delete everything")
    expect(out(r)).toContain('dialog confirm "Really delete?" dismissed')
    expect(await result(context.pages().find((p) => p.url() === url)!)).toBe("kept")
  })

  test("--json carries the dialog list", async ({ kite, torture }) => {
    await kite("tab", "new", `${torture}/alert-box`)
    const r = await kite("--json", "click", "Rename")
    const res = JSON.parse(r.stdout)
    expect(res.dialogs[0]).toMatchObject({ type: "prompt", message: "New name", handled: "dismissed" })
  })
})

test.describe("tab watcher", () => {
  test("a target=_blank tab joins the session and is usable", async ({ kite, torture }) => {
    await kite("tab", "new", `${torture}/new-tab-link`)
    const r = await kite("click", "Open report")
    const id = /⧉ new tab (\d+)/.exec(out(r))?.[1]
    expect(id, out(r)).toBeTruthy()
    const list = await kite("tab", "list")
    expect(out(list)).toContain(`tab ${id} `)
    expect((await kite("tab", "use", id!)).code).toBe(0)
    expect(out(await kite("click", "Confirm report"))).toMatch(/^✓ done$/m)
    const res = await fetch(`${torture}/__last-result`)
    expect(await res.text()).toBe("report-confirmed")
  })

  test("an OAuth popup on another domain is adopted; closing it returns to the opener", async ({ kite, context, torture, result }) => {
    const opener = `${torture}/oauth-popup`
    await kite("tab", "new", opener)
    const r = await kite("click", "Sign in with Kite")
    const id = /⧉ new tab (\d+)/.exec(out(r))?.[1]
    expect(id, out(r)).toBeTruthy()
    expect((await kite("tab", "use", id!)).code).toBe(0)
    expect(out(await kite("tab", "list"))).toMatch(new RegExp(`tab ${id} .*\\(active\\)`))
    await kite("click", "Allow")
    await expect.poll(async () => out(await kite("tab", "list")), { timeout: 5_000 }).not.toContain(`tab ${id} `)
    const list = out(await kite("tab", "list"))
    expect(list).toMatch(new RegExp(`${opener.replace(/[.]/g, "\\.")}.*\\(active\\)`))
    expect(await result(context.pages().find((p) => p.url() === opener)!)).toBe("signed-in")
  })
})

test.describe("popup closer", () => {
  test("a cookie wall is closed with Reject all and the click goes through", async ({ kite, context, torture, result }) => {
    const url = `${torture}/cookie-wall`
    await kite("tab", "new", url)
    const r = await kite("click", "Continue")
    expect(out(r)).toMatch(/^✓ done$/m)
    expect(out(r)).toContain('⨯ closed popup cookie "Reject all"')
    expect(await result(context.pages().find((p) => p.url() === url)!)).toBe("continued:none")
  })

  test("a newsletter modal is dismissed, never subscribed", async ({ kite, context, torture, result }) => {
    const url = `${torture}/newsletter-modal`
    await kite("tab", "new", url)
    await new Promise((r) => setTimeout(r, 700))
    const r = await kite("click", "Read article")
    expect(out(r)).toMatch(/^✓ done$/m)
    expect(out(r)).toContain('closed popup newsletter "Close"')
    expect(await result(context.pages().find((p) => p.url() === url)!)).toBe("read")
  })
})
