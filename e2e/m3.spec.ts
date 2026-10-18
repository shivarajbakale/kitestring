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

test.describe("dialogs in the activity log", () => {
  test("a dialog an action answered, and one the guard answered between actions, are both in kite activity", async ({ kite, context, torture }) => {
    const url = `${torture}/alert-box`
    await kite("tab", "new", url)
    await kite("click", "Delete everything")
    const page = context.pages().find((p) => p.url() === url)!
    await page.evaluate(() => void setTimeout(() => confirm("Leave already?"), 0))
    let act = ""
    for (let i = 0; i < 20 && !act.includes("Leave already?"); i++) {
      await new Promise((r) => setTimeout(r, 100))
      act = out(await kite("activity"))
    }
    expect(act).toMatch(/act\.click "Delete everything" .*! dialog confirm "Really delete\?" dismissed/)
    expect(act).toMatch(/ dialog {2}! dialog confirm "Leave already\?" dismissed/)
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

  test("a page that clears the input in its change handler still verifies (input and file chooser)", async ({ kite, context, torture }) => {
    const dir = mkdtempSync(join(tmpdir(), "kitefiles-"))
    try {
      const f = (name: string) => {
        writeFileSync(join(dir, name), name)
        return join(dir, name)
      }
      const url = `${torture}/file-upload`
      await kite("tab", "new", url)
      const d = await kite("upload", "Resume (cleared after reading)", f("cv.pdf"))
      expect(out(d)).toMatch(/^✓ done$/m)
      expect(out(d)).toContain("↑ uploaded cv.pdf")
      const e = await kite("upload", "Drop avatar here", f("me.png"))
      expect(out(e)).toMatch(/^✓ done$/m)
      expect(out(e)).toContain("↑ uploaded me.png")
      const page = context.pages().find((p) => p.url() === url)!
      expect(await page.evaluate(() => (window as unknown as { __cleared?: string }).__cleared)).toBe('{"d":["cv.pdf"],"e":["me.png"]}')
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

test.describe("batch", () => {
  const batch = async (kiteStdin: (input: string, ...args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>, steps: unknown) => {
    const r = await kiteStdin(JSON.stringify(steps), "--json", "batch", "-")
    try {
      return { code: r.code, res: JSON.parse(r.stdout) }
    } catch {
      throw new Error(`kite batch printed no JSON: ${r.stdout}${r.stderr}`)
    }
  }

  test("a form filled and submitted in one call; one activity entry per step with a shared batch id", async ({ kite, kiteStdin, context, torture, result }) => {
    const url = `${torture}/basic-form`
    await kite("tab", "new", url)
    const { code, res } = await batch(kiteStdin, [
      { action: "fill", target: "Name", value: "Ada" },
      { action: "fill", target: "Email", value: "ada@x.io" },
      { action: "click", target: "Submit" },
    ])
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(code).toBe(0)
    expect(res.steps.map((s: { status: string }) => s.status)).toEqual(["done", "done", "done"])
    expect(await result(context.pages().find((p) => p.url() === url)!)).toBe("submitted:Ada:ada@x.io")

    const entries = JSON.parse((await kite("--json", "activity")).stdout).entries as { method: string; batch?: number; target?: string }[]
    const steps = entries.filter((e) => e.batch !== undefined).reverse()
    expect(steps.map((e) => e.method)).toEqual(["act.fill", "act.fill", "act.click"])
    expect(new Set(steps.map((e) => e.batch)).size).toBe(1)
    expect(entries.some((e) => e.method === "act.batch")).toBe(false)
    expect(steps.map((e) => e.target)).toEqual(['"Name"', '"Email"', '"Submit"']) // never the filled value
  })

  test("a prompt without a dialog policy halts dialog; the alert before it is reported too", async ({ kite, kiteStdin, torture }) => {
    // "Rename" (prompt), not "Delete everything" (confirm): the risk guard would refuse that click first.
    await kite("tab", "new", `${torture}/alert-box`)
    const { code, res } = await batch(kiteStdin, [
      { action: "click", target: "Show alert" },
      { action: "click", target: "Rename" },
      { action: "click", target: "Show alert" },
    ])
    expect(code).toBe(1)
    expect(res.halted).toMatchObject({ index: 1, reason: "dialog" })
    expect(res.halted.detail).toContain('resend this step with dialog: "accept" to confirm')
    expect(res.next).toBe(1)
    expect(res.dialogs).toEqual([
      { type: "alert", message: "Hello", handled: "accepted" },
      { type: "prompt", message: "New name", handled: "dismissed" },
    ])
  })

  test("a risky click is refused before any input", async ({ kite, kiteStdin, context, torture, result }) => {
    const url = `${torture}/alert-box`
    await kite("tab", "new", url)
    const { res } = await batch(kiteStdin, [{ action: "click", target: "Delete everything" }])
    expect(res.halted).toMatchObject({ index: 0, reason: "risky" })
    expect(res.next).toBe(0)
    expect(res.dialogs).toBeUndefined()
    expect(await result(context.pages().find((p) => p.url() === url)!)).toBe("undefined")
  })

  test("a cookie wall in the way is closed and the batch goes on", async ({ kite, kiteStdin, context, torture, result }) => {
    const url = `${torture}/cookie-wall`
    await kite("tab", "new", url)
    const { res } = await batch(kiteStdin, [
      { action: "fill", target: "Email", value: "a@b.co" },
      { action: "click", target: "Continue" },
    ])
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.closedPopups.length).toBeGreaterThan(0)
    expect(await result(context.pages().find((p) => p.url() === url)!)).toBe("continued:none")
  })

  test("switch_tab new follows a target=_blank tab", async ({ kite, kiteStdin, torture }) => {
    await kite("tab", "new", `${torture}/new-tab-link`)
    const { res } = await batch(kiteStdin, [
      { action: "click", target: "Open report" },
      { action: "switch_tab", to: "new" },
      { action: "click", target: "Confirm report" },
    ])
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.newTabs).toHaveLength(1)
    expect(await (await fetch(`${torture}/__last-result`)).text()).toBe("report-confirmed")
    expect(await kite("tab", "list").then((r) => r.stdout)).toMatch(new RegExp(`tab ${res.newTabs[0]} .*\\(active\\)`))
  })

  test("kite pause mid-batch: the running step finishes, the batch halts paused before the next", async ({ kite, kiteStdin, torture }) => {
    await kite("tab", "new", `${torture}/slow-button`)
    const running = batch(kiteStdin, [
      { action: "click", target: "Load data" },
      { action: "wait", ms: 2_000 },
      { action: "click", target: "Load data" },
    ])
    await new Promise((r) => setTimeout(r, 600))
    expect((await kite("pause", "e2e")).code).toBe(0)
    const { code, res } = await running
    await kite("resume")
    expect(code).toBe(1)
    expect(res.halted?.reason, JSON.stringify(res)).toBe("paused")
    expect(res.next).toBe(res.halted.index)
    expect(res.halted.index).toBeGreaterThanOrEqual(1)
    expect(res.steps[0].status).toBe("done")
  })

  test("malformed JSON is a usage error", async ({ kiteStdin }) => {
    const r = await kiteStdin("[{", "batch", "-")
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("invalid batch: ")
  })
})

test.describe("M3 exit", () => {
  type Run = { code: number | null; stdout: string; stderr: string }
  type Stdin = (input: string, ...args: string[]) => Promise<Run>
  /** Runs one `kite batch -` call and counts it; the exit criterion is the number of these per flow. */
  const counted = () => {
    let calls = 0
    const run = async (kiteStdin: Stdin, body: unknown) => {
      calls++
      const r = await kiteStdin(JSON.stringify(body), "--json", "batch", "-")
      try {
        return JSON.parse(r.stdout)
      } catch {
        throw new Error(`kite batch printed no JSON: ${r.stdout}${r.stderr}`)
      }
    }
    return { run, calls: () => calls }
  }
  type Res = { ok: boolean; halted?: { index: number; reason: string; detail?: string }; next?: number }
  const must = (res: Res) => expect(res.ok, JSON.stringify(res)).toBe(true)

  test("alert-box: dialogs are handled inside the batch", async ({ kite, kiteStdin, context, torture, result }) => {
    const url = `${torture}/alert-box`
    await kite("tab", "new", url)
    const b = counted()
    // "Delete everything" is risky and would halt; "Rename" with a dialog policy covers the prompt path.
    must(
      await b.run(kiteStdin, [
        { action: "click", target: "Show alert" },
        { action: "click", target: "Rename", dialog: "dismiss" },
      ]),
    )
    expect(await result(context.pages().find((p) => p.url() === url)!)).toBe("rename-cancelled")
    expect(b.calls()).toBeLessThanOrEqual(3)
  })

  test("new-tab-link: opened tab is followed", async ({ kite, kiteStdin, torture }) => {
    await kite("tab", "new", `${torture}/new-tab-link`)
    const b = counted()
    must(
      await b.run(kiteStdin, [
        { action: "click", target: "Open report" },
        { action: "switch_tab", to: "new" },
        { action: "click", target: "Confirm report" },
      ]),
    )
    expect(await (await fetch(`${torture}/__last-result`)).text()).toBe("report-confirmed")
    expect(b.calls()).toBeLessThanOrEqual(3)
  })

  test("oauth-popup: popup on another domain, allowed", async ({ kite, kiteStdin, context, torture, result }) => {
    const url = `${torture}/oauth-popup`
    await kite("tab", "new", url)
    const b = counted()
    must(
      await b.run(kiteStdin, {
        allow_domains: ["localhost"],
        steps: [
          { action: "click", target: "Sign in with Kite" },
          { action: "switch_tab", to: "new" },
          { action: "click", target: "Allow" }, // the popup closes itself; the batch carries on in the opener
          { action: "scroll", direction: "down", expect: { text: "OAuth popup" } }, // runs on the opener
        ],
      }),
    )
    await expect.poll(() => result(context.pages().find((p) => p.url() === url)!)).toBe("signed-in")
    expect(out(await kite("tab", "list"))).toMatch(new RegExp(`${url.replace(/[.]/g, "\\.")}.*\\(active\\)`))
    expect(b.calls()).toBeLessThanOrEqual(3)
  })

  test("cookie-wall and newsletter-modal: the closer handles them without if_present", async ({ kite, kiteStdin, context, torture, result }) => {
    const cw = `${torture}/cookie-wall`
    await kite("tab", "new", cw)
    const b1 = counted()
    must(await b1.run(kiteStdin, [{ action: "click", target: "Continue" }]))
    expect(await result(context.pages().find((p) => p.url() === cw)!)).toBe("continued:none")
    expect(b1.calls()).toBeLessThanOrEqual(3)

    const nm = `${torture}/newsletter-modal`
    await kite("tab", "new", nm)
    await new Promise((r) => setTimeout(r, 700))
    const b2 = counted()
    must(await b2.run(kiteStdin, [{ action: "click", target: "Read article" }]))
    expect(await result(context.pages().find((p) => p.url() === nm)!)).toBe("read")
    expect(b2.calls()).toBeLessThanOrEqual(3)
  })

  test("multi-page-checkout: halts risky on Place order, one click finishes", async ({ kite, kiteStdin, context, torture, result }) => {
    await kite("tab", "new", `${torture}/multi-page-checkout`)
    const b = counted()
    const res = await b.run(kiteStdin, [
      { action: "click", target: "Proceed to shipping" },
      { action: "fill", target: "Full name", value: "Ada Lovelace" },
      { action: "fill", target: "Address", value: "12 Analytical St" },
      { action: "fill", target: "City", value: "London" },
      { action: "select", target: "Country", value: "India" },
      { action: "click", target: "Continue to payment" },
      { action: "click", target: "Place order" },
    ])
    expect(res.halted).toMatchObject({ index: 6, reason: "risky" })
    expect(res.next).toBe(6)
    const done = await kite("click", "Place order")
    expect(out(done)).toMatch(/^✓ done$/m)
    const page = context.pages().find((p) => p.url().endsWith("/multi-page-checkout-done"))!
    expect(await result(page)).toBe("order:Ada Lovelace:IN")
    expect(await (await fetch(`${torture}/__last-result`)).text()).toBe("order:Ada Lovelace:IN")
    expect(b.calls()).toBeLessThanOrEqual(3)
  })

  test("store-listing: filled and saved in ≤ 2 batches; submit halts risky, single click submits", async ({ kite, kiteStdin, context, torture, result }) => {
    const dir = mkdtempSync(join(tmpdir(), "kitefiles-"))
    try {
      const f = (name: string) => {
        writeFileSync(join(dir, name), name)
        return join(dir, name)
      }
      const url = `${torture}/store-listing`
      await kite("tab", "new", url)
      const page = () => context.pages().find((p) => p.url() === url)!
      const b = counted()
      const summary = "Drive your real Chrome from any agent: batch actions, guarded."
      must(
        await b.run(kiteStdin, [
          { action: "fill", target: "Title", value: "Kitestring" },
          { action: "fill", target: "Summary", value: summary },
          { action: "fill", target: "Description", value: "Lets agents operate your own browser safely." },
          { action: "select", target: "Category", value: "Developer Tools" },
          { action: "select", target: "Language", value: "English" },
          { action: "click", target: "Privacy", role: "tab" },
          { action: "fill", target: "Single purpose", value: "Browser automation for agents" },
          { action: "fill", target: "debugger justification", value: "Input events and snapshots" },
          { action: "fill", target: "nativeMessaging justification", value: "Talks to the local host" },
          { action: "fill", target: "tabs justification", value: "Tab groups per session" },
          { action: "fill", target: "host permissions justification", value: "Acts on any page the user opens" },
          { action: "click", target: "Does not collect user data" },
          { action: "click", target: "Package", role: "tab" },
          { action: "upload", target: "Extension zip", files: [f("kite.zip")] },
          { action: "upload", target: "Screenshots", files: [f("s1.png"), f("s2.png")] },
          { action: "click", target: "Save draft" },
        ]),
      )
      expect(await result(page())).toBe(
        "saved:" +
          JSON.stringify({
            title: "Kitestring",
            summary,
            description: "Lets agents operate your own browser safely.",
            category: "Developer Tools",
            language: "English",
            purpose: "Browser automation for agents",
            justifications: {
              debugger: "Input events and snapshots",
              nativeMessaging: "Talks to the local host",
              tabs: "Tab groups per session",
              hostPermissions: "Acts on any page the user opens",
            },
            noData: true,
            zip: ["kite.zip"],
            screenshots: ["s1.png", "s2.png"],
          }),
      )
      expect(b.calls()).toBeLessThanOrEqual(2)
      const r = await b.run(kiteStdin, [{ action: "click", target: "Submit for review" }])
      expect(r.halted).toMatchObject({ index: 0, reason: "risky" })
      expect(await result(page())).toMatch(/^saved:/)
      expect(out(await kite("click", "Submit for review"))).toMatch(/^✓ done$/m)
      expect(await result(page())).toBe("submitted")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
