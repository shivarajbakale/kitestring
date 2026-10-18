import { test, expect } from "./harness"

type Hit = { ref: string; line: string; role: string; name: string } | null
type Agent = { pressTarget(key: string): Hit }

async function press(page: import("@playwright/test").Page, id: string, key = "Enter"): Promise<Hit> {
  return page.evaluate(
    ([x, k]) => {
      document.getElementById(x!)!.focus()
      return (window as unknown as { __kiteAgent: Agent }).__kiteAgent.pressTarget(k!)
    },
    [id, key],
  )
}

test("Enter in a form field names the form's default button (the first submit control)", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await press(page, "note")).toMatchObject({ role: "button", name: "Place order", line: expect.stringContaining('button "Place order"') })
})

test("without a submit button: the form's accessible name, else its action", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await press(page, "amount")).toMatchObject({ role: "form", name: "Send money" })
  expect(await press(page, "to")).toMatchObject({ role: "form", name: "/transfer" })
})

test("a field owned by a form through form= uses that form's button", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await press(page, "owned")).toMatchObject({ role: "button", name: "Delete all" })
})

test("focus outside any form submits nothing", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await press(page, "loose")).toBeNull()
})

test("Enter in a textarea or a contenteditable inserts a line: nothing to check (N3)", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await press(page, "gift")).toBeNull()
  expect(await press(page, "ce")).toBeNull()
})

test("a focused button, button input or link: Enter activates that control, so its own name is checked (N2)", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await press(page, "del")).toMatchObject({ role: "button", name: "Delete account" })
  expect(await press(page, "pay")).toMatchObject({ role: "button", name: "Pay now" })
  expect(await press(page, "looseBtn")).toMatchObject({ role: "button", name: "Publish" })
  expect(await press(page, "link")).toMatchObject({ role: "link", name: "Remove account" })
})

test("Space activates a focused button (its own name), never a link or a text field (N2)", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await press(page, "del", "Space")).toMatchObject({ role: "button", name: "Delete account" })
  expect(await press(page, "link", "Space")).toBeNull()
  expect(await press(page, "note", "Space")).toBeNull()
})
