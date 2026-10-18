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
