import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Page } from "@playwright/test"
import { expect, loadPage, test } from "./harness"

const here = dirname(fileURLToPath(import.meta.url))
const LOGIN = join(here, "..", "..", "..", "apps", "torture", "pages", "login.html")
const RECORD = join(here, "fixtures", "record.html")

interface Ev {
  step: Record<string, unknown> & { action: string; target?: Record<string, string>; value?: string; files?: string[] }
  params: { name: string; secret: boolean }[]
  echoes: { h: number; n: number; param: string }[]
}
type Win = {
  __events: Ev[]
  __rec: { stop(): void; update(s: unknown): void }
  __startRecorder(win: Window, state: unknown, emit: (e: Ev) => void): { stop(): void; update(s: unknown): void }
}

async function record(page: Page, file: string, state = { used: [] as string[], echoes: [] as unknown[] }): Promise<void> {
  await loadPage(page, file)
  await page.evaluate((st) => {
    const w = window as unknown as Win
    w.__events = []
    w.__rec = w.__startRecorder(window, st, (e) => w.__events.push(JSON.parse(JSON.stringify(e))))
  }, state)
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Win).__events)
const steps = async (page: Page) => (await events(page)).map((e) => e.step)

test.describe("recorder on the login page (Review Focus 4)", () => {
  test("password and one-time-code values never leave the page; every value is a param", async ({ page }) => {
    await record(page, LOGIN)
    await page.getByLabel("Username").fill("ada.lovelace")
    await page.getByLabel("Password").fill("hunter2-Secret")
    await page.getByLabel("One-time code").fill("424242")
    await page.getByRole("button", { name: "Sign in" }).click()
    expect(await page.evaluate(() => (window as unknown as { __result: string }).__result)).toBe("signed-in:ada.lovelace:ok")

    const evs = await events(page)
    const wire = JSON.stringify(evs)
    for (const v of ["hunter2", "Secret", "424242", "ada.lovelace", "lovelace"]) expect(wire).not.toContain(v)
    expect(evs.map((e) => e.step)).toEqual([
      { action: "fill", target: { text: "Username", role: "textbox", within: "Sign in" }, value: "{{username}}" },
      { action: "fill", target: { text: "Password", role: "textbox", within: "Sign in" }, value: "{{password}}" },
      { action: "fill", target: { text: "One-time code", role: "textbox", within: "Sign in" }, value: "{{one_time_code}}" },
      { action: "click", target: { text: "Sign in", role: "button", within: "Sign in" } },
    ])
    expect(evs.flatMap((e) => e.params)).toEqual([
      { name: "username", secret: false },
      { name: "password", secret: true },
      { name: "one_time_code", secret: true },
    ])
    // only the non-secret value is remembered (as a hash) for later pages
    expect(evs.flatMap((e) => e.echoes).map((e) => e.param)).toEqual(["username"])
  })

  test("Enter in a field commits it and records the key once; the implicit submit adds nothing", async ({ page }) => {
    await record(page, LOGIN)
    await page.getByLabel("Username").fill("ada")
    await page.getByLabel("Username").press("Enter")
    expect(await steps(page)).toEqual([
      { action: "fill", target: { text: "Username", role: "textbox", within: "Sign in" }, value: "{{username}}" },
      { action: "press", key: "Enter" },
    ])
  })

  test("stop removes every listener", async ({ page }) => {
    await record(page, LOGIN)
    await page.evaluate(() => (window as unknown as Win).__rec.stop())
    await page.getByLabel("Username").fill("ada")
    await page.getByRole("button", { name: "Sign in" }).click()
    expect(await events(page)).toEqual([])
  })

  test("script-dispatched events are not the human's and are ignored", async ({ page }) => {
    await record(page, RECORD)
    await page.evaluate(() => {
      const t = document.getElementById("t") as HTMLInputElement
      t.value = "bot"
      t.dispatchEvent(new Event("change", { bubbles: true }))
      t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      ;[...document.querySelectorAll("button")].find((b) => b.textContent === "Unrelated")!.click()
    })
    expect(await events(page)).toEqual([])
  })
})

test.describe("recorder parameters", () => {
  test("a select becomes a param; the chosen option text is never sent", async ({ page }) => {
    await record(page, RECORD)
    await page.getByLabel("Category").focus()
    await page.keyboard.type("Fun")
    await page.getByLabel("Category").blur()
    expect(await page.$eval("#c", (s) => (s as HTMLSelectElement).value)).toBe("fun")
    const evs = await events(page)
    expect(evs.map((e) => e.step)).toEqual([
      { action: "select", target: { text: "Category", role: "combobox", within: "Listing" }, value: "{{category}}" },
    ])
    expect(JSON.stringify(evs)).not.toMatch(/fun stuff|"fun"/i)
  })

  test("clicks on text that echoes a typed value, and option clicks, are params", async ({ page }) => {
    await record(page, RECORD)
    await page.getByLabel("Store title").fill("Kite Pro")
    await page.getByRole("button", { name: "Preview Kite Pro" }).click()
    await page.getByRole("option", { name: "French" }).click()
    await page.getByRole("button", { name: "Unrelated" }).click()
    const evs = await events(page)
    expect(evs.map((e) => e.step)).toEqual([
      { action: "fill", target: { text: "Store title", role: "textbox", within: "Listing" }, value: "{{store_title}}" },
      { action: "click", target: { text: "{{store_title}}", role: "button", within: "Listing" } },
      { action: "click", target: { text: "{{language}}", role: "option", within: "Listing" } },
      { action: "click", target: { text: "Unrelated", role: "button", within: "Listing" } },
    ])
    expect(evs.flatMap((e) => e.params).map((p) => p.name)).toEqual(["store_title", "language"])
    expect(JSON.stringify(evs)).not.toMatch(/kite pro|french/i)
  })

  test("a field named after a typed value stores its role only", async ({ page }) => {
    await record(page, RECORD)
    await page.getByLabel("Store title").fill("Kite Pro")
    await page.locator("#v").fill("anything")
    await page.getByRole("button", { name: "Unrelated" }).click()
    const s = await steps(page)
    expect(s[1]).toEqual({ action: "fill", target: { role: "textbox", within: "Listing" }, value: "{{textbox}}" })
    expect(JSON.stringify(s)).not.toMatch(/kite pro|anything/i)
  })

  test("a value typed on an earlier page is matched by hash and replaced", async ({ page }) => {
    // page 1: the echo the recorder sends along (a hash, never the value)
    await record(page, RECORD)
    await page.getByLabel("Store title").fill("Kite Pro")
    await page.getByRole("button", { name: "Unrelated" }).click()
    const first = (await events(page))[0]!.echoes
    expect(first).toHaveLength(1)
    // page 2 (a fresh document): what the background hands a new page is the param names in use and those echoes
    await record(page, RECORD, { used: ["store_title"], echoes: first })
    await page.getByRole("button", { name: "Preview Kite Pro" }).click()
    await page.getByLabel("Store title").fill("other text")
    await page.getByRole("button", { name: "Unrelated" }).click()
    expect((await steps(page)).slice(0, 2)).toEqual([
      { action: "click", target: { text: "{{store_title}}", role: "button", within: "Listing" } },
      { action: "fill", target: { text: "Store title", role: "textbox", within: "Listing" }, value: "{{store_title_2}}" },
    ])
  })

  test("a file input records an upload whose file is a param; the basename never leaves", async ({ page }) => {
    await record(page, RECORD)
    // as a real file chooser does (trusted change); Playwright's setInputFiles dispatches untrusted events
    const dir = mkdtempSync(join(tmpdir(), "kiterec-"))
    writeFileSync(join(dir, "icon-private.png"), "x")
    const cdp = await page.context().newCDPSession(page)
    const { root } = await cdp.send("DOM.getDocument")
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#z" })
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [join(dir, "icon-private.png")] })
    await expect.poll(async () => (await events(page)).length).toBe(1)
    rmSync(dir, { recursive: true, force: true })
    const evs = await events(page)
    expect(evs.map((e) => e.step)).toEqual([
      { action: "upload", target: { text: "Package", role: "button", within: "Listing" }, files: ["{{package}}"] },
    ])
    expect(JSON.stringify(evs)).not.toContain("icon-private")
  })

  test("a checkbox clicked through its label is one click on the checkbox", async ({ page }) => {
    await record(page, RECORD)
    await page.getByText("I agree").click()
    expect(await steps(page)).toEqual([{ action: "click", target: { text: "I agree", role: "checkbox", within: "Listing" } }])
  })
})
