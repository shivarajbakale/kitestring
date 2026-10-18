import { test, expect } from "./harness"

type Agent = { enterSubmit(): { ref: string; line: string; role: string; name: string } | null }

async function enterOn(page: import("@playwright/test").Page, id: string) {
  return page.evaluate((x) => {
    document.getElementById(x)!.focus()
    return (window as unknown as { __kiteAgent: Agent }).__kiteAgent.enterSubmit()
  }, id)
}

test("Enter in a form field names the form's default button (the first submit control)", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await enterOn(page, "note")).toMatchObject({ role: "button", name: "Place order", line: expect.stringContaining('button "Place order"') })
})

test("without a submit button: the form's accessible name, else its action", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await enterOn(page, "amount")).toMatchObject({ role: "form", name: "Send money" })
  expect(await enterOn(page, "to")).toMatchObject({ role: "form", name: "/transfer" })
})

test("a field owned by a form through form= uses that form's button", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await enterOn(page, "owned")).toMatchObject({ role: "button", name: "Delete all" })
})

test("focus outside any form submits nothing", async ({ fixture }) => {
  const page = await fixture("enter-submit.html")
  expect(await enterOn(page, "loose")).toBeNull()
})
