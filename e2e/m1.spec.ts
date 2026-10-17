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
