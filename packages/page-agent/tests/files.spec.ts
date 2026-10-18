import type { Page } from "@playwright/test"
import { test, expect } from "./harness"

interface Agent {
  find(t: { text: string }, intent: "click"): { kind: string; ref: string }
  resolve(ref: string): Element | null
  fileInputFor(ref: string): { ref: string; multiple: boolean } | null
  fileNames(ref: string): string[] | null
  watchFileInput(ref: string): boolean
}
type Win = { __kiteAgent: Agent; __fileInputFor(el: Element): HTMLInputElement | null }

/** The id of the input the pure function picks for the element `#sel`, or null. */
function pick(page: Page, sel: string): Promise<string | null> {
  return page.evaluate((s) => (window as unknown as Win).__fileInputFor(document.querySelector(s)!)?.id ?? null, sel)
}

test("an input is its own file input", async ({ fixture }) => {
  expect(await pick(await fixture("files.html"), "#plain")).toBe("plain")
})

test("a label[for] resolves to the input it points at, even a hidden one", async ({ fixture }) => {
  expect(await pick(await fixture("files.html"), "#forlabel")).toBe("byfor")
})

test("a wrapping label resolves to its input", async ({ fixture }) => {
  expect(await pick(await fixture("files.html"), "#wraplabel")).toBe("wrapped")
})

test("a button whose container holds one hidden input resolves to it", async ({ fixture }) => {
  expect(await pick(await fixture("files.html"), "#zonebtn")).toBe("hidden")
})

test("a container with 4 file inputs is ambiguous: null", async ({ fixture }) => {
  expect(await pick(await fixture("files.html"), "#ambigbtn")).toBeNull()
})

test("an input more than 5 ancestors away is not found", async ({ fixture }) => {
  expect(await pick(await fixture("files.html"), "#farbtn")).toBeNull()
})

test("no input anywhere near: null", async ({ fixture }) => {
  expect(await pick(await fixture("files.html"), "#nonebtn")).toBeNull()
})

test("the nearest of several inputs wins", async ({ fixture }) => {
  expect(await pick(await fixture("files.html"), "#nearbtn")).toBe("near")
})

test("a drop zone does not steal the inputs of its neighbours (rendered, or nearer to their own button)", async ({ fixture }) => {
  const page = await fixture("files.html")
  expect(await pick(page, "#dropzone")).toBeNull()
  expect(await pick(page, "#trigger")).toBe("trigger-input")
})

test("agent.fileInputFor: a labelled visible input is found by its label and reports multiple", async ({ fixture }) => {
  const page = await fixture("files.html")
  const r = await page.evaluate(() => {
    const a = (window as unknown as Win).__kiteAgent
    const f = a.find({ text: "Pick archive" }, "click")
    const i = a.fileInputFor(f.ref)
    return { kind: f.kind, id: i && (a.resolve(i.ref) as Element).id, multiple: i?.multiple }
  })
  expect(r).toEqual({ kind: "found", id: "byfor", multiple: false })
})

test("agent.fileInputFor: a button resolves to its sibling hidden multiple input; ambiguous is null", async ({ fixture }) => {
  const page = await fixture("files.html")
  const r = await page.evaluate(() => {
    const a = (window as unknown as Win).__kiteAgent
    const ok = a.fileInputFor(a.find({ text: "Choose screenshots" }, "click").ref)
    const amb = a.fileInputFor(a.find({ text: "Attach" }, "click").ref)
    return { id: ok && (a.resolve(ok.ref) as Element).id, multiple: ok?.multiple, amb }
  })
  expect(r).toEqual({ id: "hidden", multiple: true, amb: null })
})

test("agent.fileNames reads input.files names", async ({ fixture }) => {
  const page = await fixture("files.html")
  const r = await page.evaluate(() => {
    const a = (window as unknown as Win).__kiteAgent
    const ref = a.fileInputFor(a.find({ text: "Choose screenshots" }, "click").ref)!.ref
    const before = a.fileNames(ref)
    const el = a.resolve(ref) as HTMLInputElement
    const dt = new DataTransfer()
    dt.items.add(new File(["1"], "s1.png"))
    dt.items.add(new File(["2"], "s2.png"))
    el.files = dt.files
    return { before, after: a.fileNames(ref), notInput: a.fileNames(a.find({ text: "Choose screenshots" }, "click").ref) }
  })
  expect(r).toEqual({ before: [], after: ["s1.png", "s2.png"], notInput: null })
})

test("adjacent styled upload buttons each get their own hidden input (either order)", async ({ fixture }) => {
  const page = await fixture("files.html")
  expect(await pick(page, "#front")).toBe("front-input")
  expect(await pick(page, "#back")).toBe("back-input")
  expect(await pick(page, "#left")).toBe("left-input")
  expect(await pick(page, "#right")).toBe("right-input")
})

test("agent.watchFileInput: names recorded at dispatch survive a page that clears the input", async ({ fixture }) => {
  const page = await fixture("files.html")
  const ref = await page.evaluate(() => {
    const a = (window as unknown as Win).__kiteAgent
    const r = a.fileInputFor(a.find({ text: "Clearing input" }, "click").ref)!.ref
    ;(window as unknown as { __ref: string }).__ref = r
    return { watched: a.watchFileInput(r), notInput: a.watchFileInput(a.find({ text: "Choose screenshots" }, "click").ref) }
  })
  expect(ref).toEqual({ watched: true, notInput: false })
  await page.setInputFiles("#clearing", [{ name: "kite.zip", mimeType: "application/zip", buffer: Buffer.from("x") }])
  const r = await page.evaluate(() => {
    const a = (window as unknown as Win).__kiteAgent
    const el = document.getElementById("clearing") as HTMLInputElement
    return { seen: (window as unknown as { __seen: string[] }).__seen, live: el.files!.length, names: a.fileNames((window as unknown as { __ref: string }).__ref) }
  })
  expect(r).toEqual({ seen: ["kite.zip"], live: 0, names: ["kite.zip"] })
})

test("agent.fileNames without a watch reads the live input (cleared: empty)", async ({ fixture }) => {
  const page = await fixture("files.html")
  await page.setInputFiles("#clearing", [{ name: "kite.zip", mimeType: "application/zip", buffer: Buffer.from("x") }])
  const names = await page.evaluate(() => {
    const a = (window as unknown as Win).__kiteAgent
    return a.fileNames(a.fileInputFor(a.find({ text: "Clearing input" }, "click").ref)!.ref)
  })
  expect(names).toEqual([])
})
