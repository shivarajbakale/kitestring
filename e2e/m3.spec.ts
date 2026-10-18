import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

test.describe("file upload", () => {
  test("input, hidden input behind a button, and a drop zone (file chooser)", async ({ kite, context, torture, result }) => {
    const dir = mkdtempSync(join(tmpdir(), "kitefiles-"))
    try {
      const f = (name: string) => {
        writeFileSync(join(dir, name), name)
        return join(dir, name)
      }
      const url = `${torture}/file-upload`
      await kite("tab", "new", url)
      expect(out(await kite("upload", "Extension zip", f("kite.zip")))).toMatch(/^✓ done$/m)
      const b = await kite("upload", "Choose screenshots", f("s1.png"), f("s2.png"))
      expect(out(b)).toMatch(/^✓ done$/m)
      expect(out(b)).toContain("↑ uploaded s1.png, s2.png")
      expect(out(await kite("upload", "Drop icon here", f("icon.png")))).toMatch(/^✓ done$/m)
      const page = context.pages().find((p) => p.url() === url)!
      expect(await result(page)).toBe('{"a":["kite.zip"],"b":["s1.png","s2.png"],"c":["icon.png"]}')

      // Base names only in the activity log.
      const act = out(await kite("activity"))
      expect(act).toContain("← kite.zip")
      expect(act).toContain("← s1.png, s2.png")
      expect(act).not.toContain(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a sensitive path is refused by the CLI before the browser is touched", async ({ kite, kiteEnv, torture }) => {
    await kite("tab", "new", `${torture}/file-upload`)
    const home = mkdtempSync(join(tmpdir(), "kitehome-"))
    try {
      mkdirSync(join(home, ".ssh"))
      writeFileSync(join(home, ".ssh", "x"), "key")
      const r = await kiteEnv({ HOME: home }, "upload", "Extension zip", join(home, ".ssh", "x"))
      expect(r.code).toBe(1)
      expect(out(r)).toContain("refusing to upload")
      expect(out(await kite("activity"))).not.toContain("act.upload")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("more than one file for a single-file input is a BAD_REQUEST", async ({ kite, torture }) => {
    const dir = mkdtempSync(join(tmpdir(), "kitefiles-"))
    try {
      writeFileSync(join(dir, "1.zip"), "1")
      writeFileSync(join(dir, "2.zip"), "2")
      await kite("tab", "new", `${torture}/file-upload`)
      const r = await kite("upload", "Extension zip", join(dir, "1.zip"), join(dir, "2.zip"))
      expect(r.code).toBe(1)
      expect(out(r)).toContain("takes one file")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
