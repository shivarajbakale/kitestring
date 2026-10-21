import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "./fixtures"

// kite extract in a real Chrome: a paged table, read into a CSV someone opens in a spreadsheet.

test.describe("extract to a clean CSV", () => {
  test("without --id a row changed between pages is read twice; --columns and --id give one row per order", async ({ kite, kiteHome, torture }) => {
    await kite("tab", "new", `${torture}/orders-table`)
    const raw = await kite("extract", "--next", "Next", "--pages", "2")
    expect(raw.code).toBe(0)
    expect(raw.stdout.split("\n")[0]).toBe("Order,Date,Status,Updated,Total")
    expect(raw.stdout.match(/^1003,/gm)).toHaveLength(2)

    await kite("tab", "new", `${torture}/orders-table`)
    const file = join(kiteHome, "orders.csv")
    const r = await kite("extract", "--next", "Next", "--pages", "2", "--columns", "Order,Total,Status", "--id", "Order", "-o", file)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`saved ${file}`)
    expect(readFileSync(file, "utf8")).toBe('Order,Total,Status\n1001,$12.00,paid\n1002,"$1,240.50",paid\n1003,\'=1+1,pending\n1004,$8.25,shipped\n')
  })

  test("a column that is not there fails before writing and names the ones that are", async ({ kite, torture }) => {
    await kite("tab", "new", `${torture}/orders-table`)
    const r = await kite("extract", "--columns", "Order=order-id")
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('no column "order-id"; the columns are: Order, Date, Status, Updated, Total')
  })
})

test.describe("lists in a panel of their own, and scripts that save", () => {
  test("scroll paging wheels over the results panel, not the map at the viewport's centre", async ({ kite, torture, context, result }) => {
    await kite("tab", "new", `${torture}/panel-list`)
    const r = await kite("extract", "--next", "scroll", "--pages", "10")
    expect(r.code).toBe(0)
    expect(r.stderr).toMatch(/^45 rows × /)
    expect(r.stdout).toContain("Warehouse 45")
    const page = context.pages().find((p) => p.url().endsWith("/panel-list"))!
    expect(await result(page)).toBe("undefined")
  })

  test("--save writes the rows a script returns; a value that is not rows is refused", async ({ kite, kiteStdin, kiteHome, torture }) => {
    await kite("tab", "new", `${torture}/panel-list`)
    const file = join(kiteHome, "places.csv")
    const rows = `return await evaluate(() => [...document.querySelectorAll(".place")].slice(0, 3).map((p) => ({ Name: p.querySelector(".name").innerText, Phone: p.querySelector(".phone").innerText })))`
    const r = await kiteStdin(rows, "script", "-", "--save", file)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`→ 3 rows × 2 columns saved to ${file}`)
    expect(readFileSync(file, "utf8")).toBe("Name,Phone\nWarehouse 1,0836 000001\nWarehouse 2,0836 000002\nWarehouse 3,0836 000003\n")
    const bad = await kiteStdin(`return "done"`, "script", "-", "--save", join(kiteHome, "bad.csv"))
    expect(bad.code).not.toBe(0)
    expect(bad.stderr).toContain("save needs the script to return its rows: an array of objects, one per row (it returned string)")
  })
})
