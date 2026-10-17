import { expect, test } from "./fixtures"

const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr
const tabIdOf = (stdout: string) => Number(/^tab (\d+)/m.exec(stdout)?.[1])

test.describe("sessions", () => {
  test("status reports connected", async ({ bx }) => {
    const r = await bx("status", "--json")
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ connected: true, sessions: [] })
  })

  test("tab new opens a tab in the session's group", async ({ bx, torture, sw }) => {
    const url = `${torture}/basic-form`
    const created = await bx("tab", "new", url)
    expect(out(created)).toContain(url)
    expect(created.code).toBe(0)
    const id = tabIdOf(created.stdout)

    const list = await bx("tab", "list")
    expect(list.code).toBe(0)
    expect(list.stdout.trim().split("\n")).toEqual([`tab ${id} ${url}`])

    const groups = await sw.evaluate(() => chrome.tabGroups.query({ title: "bx:default" }))
    expect(groups).toHaveLength(1)
    const tab = await sw.evaluate((id) => chrome.tabs.get(id), id)
    expect(tab.groupId).toBe(groups[0]!.id)

    const status = await bx("status", "--json")
    expect(JSON.parse(status.stdout).sessions).toEqual(["default"])
  })

  test("another session cannot close a tab it does not own", async ({ bx, bxEnv, torture, sw }) => {
    const id = tabIdOf((await bx("tab", "new", `${torture}/basic-form`)).stdout)
    const r = await bxEnv({ BX_SESSION: "other" }, "tab", "close", String(id))
    expect([1, 2]).toContain(r.code)
    expect(out(r)).toContain("NOT_OWNER")
    expect(await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.id), id)).toBe(id)
    expect((await bxEnv({ BX_SESSION: "other" }, "tab", "list")).stdout.trim()).toBe("")
  })

  test("tab use / close within a session; user-closed tabs leave the session", async ({ bx, torture, context }) => {
    const a = tabIdOf((await bx("tab", "new", `${torture}/basic-form`)).stdout)
    const b = tabIdOf((await bx("tab", "new", `${torture}/whitespace`)).stdout)
    const used = await bx("tab", "use", String(a))
    expect(used.code).toBe(0)
    expect(used.stdout).toContain(`tab ${a} ${torture}/basic-form`)
    expect((await bx("snapshot")).stdout).toContain("Basic form")

    expect((await bx("tab", "close", String(b))).code).toBe(0)
    expect((await bx("tab", "list")).stdout.trim()).toBe(`tab ${a} ${torture}/basic-form`)

    // The user closes the remaining tab by hand.
    await context.pages().find((p) => p.url() === `${torture}/basic-form`)!.close()
    await expect.poll(async () => (await bx("tab", "list")).stdout.trim()).toBe("")
    const snap = await bx("snapshot")
    expect(snap.code).toBe(1)
    expect(out(snap)).toContain("NO_TAB")
  })

  test("snapshot of the session's active tab", async ({ bx, torture, context, result }) => {
    await bx("tab", "new", `${torture}/basic-form`)
    const snap = await bx("snapshot")
    expect(snap.code).toBe(0)
    expect(snap.stdout).toContain("Basic form")
    expect(snap.stdout).toMatch(/@e[0-9a-z]{5}/)
    const page = context.pages().find((p) => p.url() === `${torture}/basic-form`)!
    expect(await result(page)).toBe("undefined")
  })

  test("restricted page answers quickly with a clear message", async ({ bx }) => {
    expect((await bx("tab", "new", "chrome://settings")).code).toBe(0)
    const r = await bx("snapshot")
    expect(out(r)).toContain("restricted")
    expect(out(r)).toContain("chrome://settings")
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(3000)
  })
})

test.describe("restricted detection", () => {
  test("a page the extension cannot script is reported as restricted, not as an error", async ({ bx }) => {
    // data: URLs are not on the prefix list; detection must come from the failed injection.
    const url = "data:text/html,<h1>hi</h1>"
    expect((await bx("tab", "new", url)).code).toBe(0)
    const r = await bx("snapshot")
    expect(out(r)).toContain("restricted page")
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(3000)
  })
})

// ---------------------------------------------------------------------------------------------
// Task 9: the action pipeline against every torture page (apps/torture/expected.md).
// ---------------------------------------------------------------------------------------------

type Ctx = { bx: (...a: string[]) => Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> }

const DONE = /^✓ done$/m

async function open(
  { bx, context }: Ctx & { context: import("@playwright/test").BrowserContext },
  url: string,
): Promise<import("@playwright/test").Page> {
  const r = await bx("tab", "new", url)
  expect(r.code, out(r)).toBe(0)
  const page = context.pages().find((p) => p.url() === url)
  if (!page) throw new Error(`no page for ${url}`)
  return page
}

async function ok(bx: Ctx["bx"], ...args: string[]) {
  const r = await bx(...args)
  expect(out(r)).toMatch(DONE)
  expect(r.code, out(r)).toBe(0)
  return r
}

test.describe("torture", () => {
  test("basic-form", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/basic-form`)
    await ok(bx, "fill", "Name", "Ada")
    await ok(bx, "fill", "Email", "ada@x.io")
    await ok(bx, "click", "Submit")
    expect(await result(page)).toBe("submitted:Ada:ada@x.io")
  })

  test("duplicate-buttons", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/duplicate-buttons`)
    await ok(bx, "click", "Save", "--within", "Profile")
    expect(await result(page)).toBe("saved:profile")
  })

  test("icon-only", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/icon-only`)
    await ok(bx, "click", "Delete item")
    expect(await result(page)).toBe("deleted")
  })

  test("covered-by-banner", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/covered-by-banner`)
    const first = await bx("click", "Continue")
    expect(first.code).toBe(1)
    expect(first.stdout).toContain("blocked")
    expect(first.stdout).toContain("Cookie banner")
    expect(await result(page)).toBe("undefined")
    await ok(bx, "click", "Accept")
    await ok(bx, "click", "Continue")
    expect(await result(page)).toBe("continued")
  })

  test("infinite-scroll", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/infinite-scroll`)
    await ok(bx, "click", "Item 57")
    expect(await result(page)).toBe("item:57")
  })

  test("slow-button", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/slow-button`)
    const r = await ok(bx, "click", "Load data")
    expect(r.stdout).toMatch(/^\+ .*Data ready/m)
    expect(await result(page)).toBe("loaded")
  })

  test("never-idle", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/never-idle`)
    const r = await ok(bx, "click", "Go")
    expect(r.ms).toBeLessThan(3000)
    expect(await result(page)).toBe("go")
  })

  test("disabled-until-valid", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/disabled-until-valid`)
    const first = await bx("click", "Submit")
    expect(first.code).toBe(1)
    expect(first.stdout).toContain("disabled")
    expect(first.stdout).toContain("Enter a valid email")
    await ok(bx, "fill", "Email", "ada@x.io")
    await ok(bx, "click", "Submit")
    expect(await result(page)).toBe("ok")
  })

  test("rerender", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/rerender`)
    const snap = await bx("snapshot")
    const ref = /button "Pick me" \[(@e[0-9a-z]{5})\]/.exec(snap.stdout)?.[1]
    expect(ref, snap.stdout).toBeTruthy()
    await new Promise((r) => setTimeout(r, 1000))
    await ok(bx, "click", ref!)
    expect(await result(page)).toBe("picked")
  })

  test("native-select", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/native-select`)
    await ok(bx, "select", "Country", "India")
    expect(await result(page)).toBe("country:IN")
  })

  test("navigating-link", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/navigating-link`)
    const r = await ok(bx, "click", "Next page")
    expect(r.stdout).toContain("→ navigated")
    expect(r.stdout).toContain("/navigating-link-done")
    expect(page.url()).toBe(`${torture}/navigating-link-done`)
    expect(await result(page)).toBe("arrived")
    // The page agent survived the navigation: further commands work on the new page.
    expect((await bx("snapshot")).stdout).toContain('heading "Arrived"')
  })

  test("navigating click re-injects the page agent when the new document has none yet", async ({ bx, context, torture, sw }) => {
    // Whether the manifest content script is already in the new document when the pipeline first
    // asks it something is a race; repeat until one navigation went through inject-and-retry.
    const page = await open({ bx, context }, `${torture}/navigating-link`)
    const injections = () => sw.evaluate(() => (globalThis as { __bxStats?: { injections: number } }).__bxStats!.injections)
    for (let i = 0; i < 5 && (await injections()) === 0; i++) {
      if (i > 0) await ok(bx, "goto", `${torture}/navigating-link`)
      const r = await ok(bx, "click", "Next page")
      expect(r.stdout).toContain(`→ navigated ${torture}/navigating-link-done`)
      expect(page.url()).toBe(`${torture}/navigating-link-done`)
    }
    expect(await injections()).toBeGreaterThan(0)
  })

  test("whitespace", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/whitespace`)
    await ok(bx, "click", "  save changes ")
    expect(await result(page)).toBe("saved")
  })
})

test.describe("pipeline", () => {
  test("goto navigates the active tab and reports the new page", async ({ bx, context, torture }) => {
    const page = await open({ bx, context }, `${torture}/basic-form`)
    const r = await ok(bx, "goto", `${torture}/whitespace`)
    expect(r.stdout).toContain(`→ navigated ${torture}/whitespace`)
    expect(r.stdout).toMatch(/^page: whitespace \| .*\/whitespace \| Whitespace \| 1 interactive$/m)
    expect(page.url()).toBe(`${torture}/whitespace`)
  })

  test("goto from a tab that starts on about:blank", async ({ bx, torture }) => {
    expect((await bx("tab", "new")).code).toBe(0)
    const r = await ok(bx, "goto", `${torture}/whitespace`)
    expect(r.stdout).toContain(`→ navigated ${torture}/whitespace`)
    await ok(bx, "click", "Save changes")
  })

  test("press acts on the focused element", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/basic-form`)
    await ok(bx, "fill", "Name", "Ada")
    await ok(bx, "fill", "Email", "ada@x.io")
    await ok(bx, "press", "Enter")
    expect(await result(page)).toBe("submitted:Ada:ada@x.io")
  })

  test("fill replaces the existing value", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/basic-form`)
    await ok(bx, "fill", "Name", "Grace Hopper")
    await ok(bx, "fill", "Name", "Ada")
    expect(await page.inputValue("#n")).toBe("Ada")
    void result
  })

  test("unknown key is a bad request", async ({ bx, context, torture }) => {
    await open({ bx, context }, `${torture}/basic-form`)
    const r = await bx("press", "Hyper")
    expect(r.code).toBe(1)
    expect(out(r)).toContain("unknown key")
  })

  test("scroll down one viewport reveals more content", async ({ bx, context, torture }) => {
    const page = await open({ bx, context }, `${torture}/infinite-scroll`)
    const r = await ok(bx, "scroll", "down")
    expect(r.stdout).toMatch(/^\+ button "Item \d+"/m)
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(300)
    await ok(bx, "scroll", "up", "10000")
    expect(await page.evaluate(() => scrollY)).toBe(0)
  })

  test("ambiguous target lists candidates", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/duplicate-buttons`)
    const r = await bx("click", "Save")
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("ambiguous")
    expect(r.stdout.match(/^ {2}@e[0-9a-z]{5} button "Save"/gm)).toHaveLength(2)
    expect(await result(page)).toBe("undefined")
  })

  test("missing target is not_found after scrolling", async ({ bx, context, torture }) => {
    await open({ bx, context }, `${torture}/whitespace`)
    const r = await bx("click", "Nonexistent thing")
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("not_found")
  })

  test("a click that changes nothing is no_effect", async ({ bx, context, torture }) => {
    const page = await open({ bx, context }, `${torture}/whitespace`)
    await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend", "<button>Dead</button>"))
    const r = await bx("click", "Dead")
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("no_effect")
  })

  test("debugger is re-attached after it was detached (e.g. infobar cancelled)", async ({ bx, context, torture, sw, result }) => {
    const page = await open({ bx, context }, `${torture}/icon-only`)
    const id = tabIdOf((await bx("tab", "list")).stdout)
    await ok(bx, "click", "Settings") // attaches
    expect(await result(page)).toBe("WRONG:settings")
    // Detach the extension's own session (Playwright's CDP connection is separate and unaffected).
    await sw.evaluate((id) => chrome.debugger.detach({ tabId: id }), id)
    await ok(bx, "click", "Delete item")
    expect(await result(page)).toBe("deleted")
  })

  test("a page that never becomes ready answers timeout, still with diff and page", async ({ bx, context, torture, result }) => {
    const page = await open({ bx, context }, `${torture}/whitespace`)
    await page.evaluate(() =>
      document.querySelector("button")!.addEventListener("click", () =>
        document.querySelector("main")!.insertAdjacentHTML("beforeend", '<h2>Busy</h2><div role="progressbar">…</div>'),
      ),
    )
    const r = await bx("click", "Save changes")
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/^✗ timeout/m)
    expect(r.stdout).toContain('+ heading "Busy"')
    expect(r.stdout).toMatch(/^page: whitespace \|/m)
    expect(r.ms).toBeLessThan(15_000)
    expect(await result(page)).toBe("saved")
  })

  test("actions on a restricted page answer RESTRICTED", async ({ bx }) => {
    expect((await bx("tab", "new", "chrome://settings")).code).toBe(0)
    const r = await bx("click", "Search")
    expect(r.code).toBe(1)
    expect(out(r)).toContain("restricted page (chrome://settings")
    expect(r.ms).toBeLessThan(3000)
  })
})
