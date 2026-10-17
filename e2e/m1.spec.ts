import { expect, test } from "./fixtures"

const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr
const tabIdOf = (stdout: string) => Number(/^tab (\d+)/m.exec(stdout)?.[1])

test.describe("sessions", () => {
  test("status reports connected", async ({ kite }) => {
    const r = await kite("status", "--json")
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ connected: true, sessions: [] })
  })

  test("tab new opens a tab in the session's group", async ({ kite, torture, sw }) => {
    const url = `${torture}/basic-form`
    const created = await kite("tab", "new", url)
    expect(out(created)).toContain(url)
    expect(created.code).toBe(0)
    const id = tabIdOf(created.stdout)

    const list = await kite("tab", "list")
    expect(list.code).toBe(0)
    expect(list.stdout.trim().split("\n")).toEqual([`tab ${id} ${url}`])

    const groups = await sw.evaluate(() => chrome.tabGroups.query({ title: "kite:default" }))
    expect(groups).toHaveLength(1)
    const tab = await sw.evaluate((id) => chrome.tabs.get(id), id)
    expect(tab.groupId).toBe(groups[0]!.id)

    const status = await kite("status", "--json")
    expect(JSON.parse(status.stdout).sessions).toEqual(["default"])
  })

  test("another session cannot close a tab it does not own", async ({ kite, kiteEnv, torture, sw }) => {
    const id = tabIdOf((await kite("tab", "new", `${torture}/basic-form`)).stdout)
    const r = await kiteEnv({ KITE_SESSION: "other" }, "tab", "close", String(id))
    expect([1, 2]).toContain(r.code)
    expect(out(r)).toContain("NOT_OWNER")
    expect(await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.id), id)).toBe(id)
    expect((await kiteEnv({ KITE_SESSION: "other" }, "tab", "list")).stdout.trim()).toBe("")
  })

  test("tab use / close within a session; user-closed tabs leave the session", async ({ kite, torture, context }) => {
    const a = tabIdOf((await kite("tab", "new", `${torture}/basic-form`)).stdout)
    const b = tabIdOf((await kite("tab", "new", `${torture}/whitespace`)).stdout)
    const used = await kite("tab", "use", String(a))
    expect(used.code).toBe(0)
    expect(used.stdout).toContain(`tab ${a} ${torture}/basic-form`)
    expect((await kite("snapshot")).stdout).toContain("Basic form")

    expect((await kite("tab", "close", String(b))).code).toBe(0)
    expect((await kite("tab", "list")).stdout.trim()).toBe(`tab ${a} ${torture}/basic-form`)

    // The user closes the remaining tab by hand.
    await context.pages().find((p) => p.url() === `${torture}/basic-form`)!.close()
    await expect.poll(async () => (await kite("tab", "list")).stdout.trim()).toBe("")
    const snap = await kite("snapshot")
    expect(snap.code).toBe(1)
    expect(out(snap)).toContain("NO_TAB")
  })

  test("snapshot of the session's active tab", async ({ kite, torture, context, result }) => {
    await kite("tab", "new", `${torture}/basic-form`)
    const snap = await kite("snapshot")
    expect(snap.code).toBe(0)
    expect(snap.stdout).toContain("Basic form")
    expect(snap.stdout).toMatch(/@e[0-9a-z]{5}/)
    const page = context.pages().find((p) => p.url() === `${torture}/basic-form`)!
    expect(await result(page)).toBe("undefined")
  })

  test("restricted page answers quickly with a clear message", async ({ kite }) => {
    expect((await kite("tab", "new", "chrome://settings")).code).toBe(0)
    const r = await kite("snapshot")
    expect(out(r)).toContain("restricted")
    expect(out(r)).toContain("chrome://settings")
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(3000)
  })
})

test.describe("blank tab and stuck pages", () => {
  test("snapshot of a blank tab names about:blank and suggests goto", async ({ kite }) => {
    expect((await kite("tab", "new")).code).toBe(0)
    const r = await kite("snapshot")
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("restricted page (about:blank)")
    expect(r.stderr).toContain("(blank tab — run kite goto <url>)")
  })

  test("snapshot of a page that never finishes loading answers TIMEOUT within the bound", async ({ kiteEnv, torture }) => {
    // The CLI's own bound is raised so only the extension's snapshot bound (15 s) can answer.
    const env = { KITE_TIMEOUT_MS: "40000" }
    expect((await kiteEnv(env, "tab", "new", `${torture}/hang`)).code).toBe(0)
    const r = await kiteEnv(env, "snapshot")
    expect(out(r)).toContain("TIMEOUT")
    expect(out(r)).not.toContain("timed out waiting for the browser")
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(17_000)
  })
})

test.describe("restricted detection", () => {
  test("a page the extension cannot script is reported as restricted, not as an error", async ({ kite }) => {
    // data: URLs are not on the prefix list; detection must come from the failed injection.
    const url = "data:text/html,<h1>hi</h1>"
    expect((await kite("tab", "new", url)).code).toBe(0)
    const r = await kite("snapshot")
    expect(out(r)).toContain("restricted page")
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(3000)
  })
})

// ---------------------------------------------------------------------------------------------
// Task 9: the action pipeline against every torture page (apps/torture/expected.md).
// ---------------------------------------------------------------------------------------------

type Ctx = { kite: (...a: string[]) => Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> }

const DONE = /^✓ done$/m

async function open(
  { kite, context }: Ctx & { context: import("@playwright/test").BrowserContext },
  url: string,
): Promise<import("@playwright/test").Page> {
  const r = await kite("tab", "new", url)
  expect(r.code, out(r)).toBe(0)
  const page = context.pages().find((p) => p.url() === url)
  if (!page) throw new Error(`no page for ${url}`)
  return page
}

async function ok(kite: Ctx["kite"], ...args: string[]) {
  const r = await kite(...args)
  expect(out(r)).toMatch(DONE)
  expect(r.code, out(r)).toBe(0)
  return r
}

test.describe("torture", () => {
  test("basic-form", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/basic-form`)
    await ok(kite, "fill", "Name", "Ada")
    await ok(kite, "fill", "Email", "ada@x.io")
    await ok(kite, "click", "Submit")
    expect(await result(page)).toBe("submitted:Ada:ada@x.io")
  })

  test("duplicate-buttons", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/duplicate-buttons`)
    await ok(kite, "click", "Save", "--within", "Profile")
    expect(await result(page)).toBe("saved:profile")
  })

  test("icon-only", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/icon-only`)
    await ok(kite, "click", "Delete item")
    expect(await result(page)).toBe("deleted")
  })

  test("covered-by-banner", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/covered-by-banner`)
    const first = await kite("click", "Continue")
    expect(first.code).toBe(1)
    expect(first.stdout).toContain("blocked")
    expect(first.stdout).toContain("Cookie banner")
    expect(await result(page)).toBe("undefined")
    await ok(kite, "click", "Accept")
    await ok(kite, "click", "Continue")
    expect(await result(page)).toBe("continued")
  })

  test("infinite-scroll", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/infinite-scroll`)
    await ok(kite, "click", "Item 57")
    expect(await result(page)).toBe("item:57")
  })

  test("slow-button", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/slow-button`)
    const r = await ok(kite, "click", "Load data")
    expect(r.stdout).toMatch(/^\+ .*Data ready/m)
    expect(await result(page)).toBe("loaded")
  })

  test("never-idle", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/never-idle`)
    const r = await ok(kite, "click", "Go")
    expect(r.ms).toBeLessThan(3000)
    expect(await result(page)).toBe("go")
  })

  test("disabled-until-valid", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/disabled-until-valid`)
    const first = await kite("click", "Submit")
    expect(first.code).toBe(1)
    expect(first.stdout).toContain("disabled")
    expect(first.stdout).toContain("Enter a valid email")
    await ok(kite, "fill", "Email", "ada@x.io")
    await ok(kite, "click", "Submit")
    expect(await result(page)).toBe("ok")
  })

  test("rerender", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/rerender`)
    const snap = await kite("snapshot")
    const ref = /button "Pick me" \[(@e[0-9a-z]{5})\]/.exec(snap.stdout)?.[1]
    expect(ref, snap.stdout).toBeTruthy()
    await new Promise((r) => setTimeout(r, 1000))
    await ok(kite, "click", ref!)
    expect(await result(page)).toBe("picked")
  })

  test("native-select", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/native-select`)
    await ok(kite, "select", "Country", "India")
    expect(await result(page)).toBe("country:IN")
  })

  test("navigating-link", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/navigating-link`)
    const r = await ok(kite, "click", "Next page")
    expect(r.stdout).toContain("→ navigated")
    expect(r.stdout).toContain("/navigating-link-done")
    expect(page.url()).toBe(`${torture}/navigating-link-done`)
    expect(await result(page)).toBe("arrived")
    // The page agent survived the navigation: further commands work on the new page.
    expect((await kite("snapshot")).stdout).toContain('heading "Arrived"')
  })

  test("navigating click re-injects the page agent when the new document has none yet", async ({ kite, context, torture, sw }) => {
    // Whether the manifest content script is already in the new document when the pipeline first
    // asks it something is a race; repeat until one navigation went through inject-and-retry.
    const page = await open({ kite, context }, `${torture}/navigating-link`)
    const injections = () => sw.evaluate(() => (globalThis as { __kiteStats?: { injections: number } }).__kiteStats!.injections)
    for (let i = 0; i < 5 && (await injections()) === 0; i++) {
      if (i > 0) await ok(kite, "goto", `${torture}/navigating-link`)
      const r = await ok(kite, "click", "Next page")
      expect(r.stdout).toContain(`→ navigated ${torture}/navigating-link-done`)
      expect(page.url()).toBe(`${torture}/navigating-link-done`)
    }
    expect(await injections()).toBeGreaterThan(0)
  })

  test("whitespace", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/whitespace`)
    await ok(kite, "click", "  save changes ")
    expect(await result(page)).toBe("saved")
  })
})

test.describe("pipeline", () => {
  test("goto navigates the active tab and reports the new page", async ({ kite, context, torture }) => {
    const page = await open({ kite, context }, `${torture}/basic-form`)
    const r = await ok(kite, "goto", `${torture}/whitespace`)
    expect(r.stdout).toContain(`→ navigated ${torture}/whitespace`)
    expect(r.stdout).toMatch(/^page: whitespace \| .*\/whitespace \| Whitespace \| 1 interactive$/m)
    expect(page.url()).toBe(`${torture}/whitespace`)
  })

  test("goto from a tab that starts on about:blank", async ({ kite, torture }) => {
    expect((await kite("tab", "new")).code).toBe(0)
    const r = await ok(kite, "goto", `${torture}/whitespace`)
    expect(r.stdout).toContain(`→ navigated ${torture}/whitespace`)
    await ok(kite, "click", "Save changes")
  })

  test("press acts on the focused element", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/basic-form`)
    await ok(kite, "fill", "Name", "Ada")
    await ok(kite, "fill", "Email", "ada@x.io")
    await ok(kite, "press", "Enter")
    expect(await result(page)).toBe("submitted:Ada:ada@x.io")
  })

  test("fill replaces the existing value", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/basic-form`)
    await ok(kite, "fill", "Name", "Grace Hopper")
    await ok(kite, "fill", "Name", "Ada")
    expect(await page.inputValue("#n")).toBe("Ada")
    void result
  })

  test("unknown key is a bad request", async ({ kite, context, torture }) => {
    await open({ kite, context }, `${torture}/basic-form`)
    const r = await kite("press", "Hyper")
    expect(r.code).toBe(1)
    expect(out(r)).toContain("unknown key")
  })

  test("scroll down one viewport reveals more content", async ({ kite, context, torture }) => {
    const page = await open({ kite, context }, `${torture}/infinite-scroll`)
    const r = await ok(kite, "scroll", "down")
    expect(r.stdout).toMatch(/^\+ button "Item \d+"/m)
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(300)
    await ok(kite, "scroll", "up", "10000")
    expect(await page.evaluate(() => scrollY)).toBe(0)
  })

  test("ambiguous target lists candidates", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/duplicate-buttons`)
    const r = await kite("click", "Save")
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("ambiguous")
    expect(r.stdout.match(/^ {2}@e[0-9a-z]{5} button "Save"/gm)).toHaveLength(2)
    expect(await result(page)).toBe("undefined")
  })

  test("missing target is not_found after scrolling", async ({ kite, context, torture }) => {
    await open({ kite, context }, `${torture}/whitespace`)
    const r = await kite("click", "Nonexistent thing")
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("not_found")
  })

  test("a click that changes nothing is no_effect", async ({ kite, context, torture }) => {
    const page = await open({ kite, context }, `${torture}/whitespace`)
    await page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend", "<button>Dead</button>"))
    const r = await kite("click", "Dead")
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("no_effect")
  })

  test("debugger is re-attached after it was detached (e.g. infobar cancelled)", async ({ kite, context, torture, sw, result }) => {
    const page = await open({ kite, context }, `${torture}/icon-only`)
    const id = tabIdOf((await kite("tab", "list")).stdout)
    await ok(kite, "click", "Settings") // attaches
    expect(await result(page)).toBe("WRONG:settings")
    // Detach the extension's own session (Playwright's CDP connection is separate and unaffected).
    await sw.evaluate((id) => chrome.debugger.detach({ tabId: id }), id)
    await ok(kite, "click", "Delete item")
    expect(await result(page)).toBe("deleted")
  })

  test("a page that never becomes ready answers timeout, still with diff and page", async ({ kite, context, torture, result }) => {
    const page = await open({ kite, context }, `${torture}/whitespace`)
    await page.evaluate(() =>
      document.querySelector("button")!.addEventListener("click", () =>
        document.querySelector("main")!.insertAdjacentHTML("beforeend", '<h2>Busy</h2><div role="progressbar">…</div>'),
      ),
    )
    const r = await kite("click", "Save changes")
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/^✗ timeout/m)
    expect(r.stdout).toContain('+ heading "Busy"')
    expect(r.stdout).toMatch(/^page: whitespace \|/m)
    expect(r.ms).toBeLessThan(15_000)
    expect(await result(page)).toBe("saved")
  })

  test("actions on a restricted page answer RESTRICTED", async ({ kite }) => {
    expect((await kite("tab", "new", "chrome://settings")).code).toBe(0)
    const r = await kite("click", "Search")
    expect(r.code).toBe(1)
    expect(out(r)).toContain("restricted page (chrome://settings")
    expect(r.ms).toBeLessThan(3000)
  })
})
