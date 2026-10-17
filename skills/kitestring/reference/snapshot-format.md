# Snapshot and result format

## Snapshot (`kite snapshot` / `browser_snapshot`)

```
page "Checkout" https://shop.test/checkout
main
  heading "Shipping address"
  textbox "Full name" [@e1k2d9] value=""
  textbox "Password" [@e4m0qa] value="••••"
  combobox "Country" [@e0p3la] value="India"
  checkbox "Save address" [@e9zz01] checked
  button "Continue" [@e7hs02] disabled
  list "Results" (50 items) item[0..2] … +47
    link "Item 1" [@e2b8cc]
```

- Line 1: `page "<title>" <url>`.
- Indentation (2 spaces) = nesting under landmarks (`main`, `navigation`, `banner`, `contentinfo`, `complementary`, `form`, `region`, `dialog`, `alertdialog`), headings and named lists.
- Controls: `<role> "<accessible name>" [@ref]` + annotations:
  - `value="…"` on textbox, searchbox, combobox, spinbutton, slider (passwords show `••••` when filled)
  - `disabled`, `checked`, `expanded`
- Long lists collapse: first 3 items shown, `… +N` hidden. Use `--full` or scroll to reach the rest.
- **Not shown:** plain paragraphs, labels, alert/toast text, images. Use a screenshot for those, or rely on the `disabled` detail which carries visible form errors.
- Default scope is the **viewport**. `--full` = whole page. `--scope @ref` = only that element's subtree (implies full).

## Refs

`@e` + 5 base36 chars (e.g. `@e7hs02`). Derived from role + name + landmark path + position, so a ref survives re-renders that keep the same content. A ref that no longer matches gives `not_found`: snapshot again.

## Targets

Any argument that is not a ref is visible text: accessible name, label or placeholder. Matching is case-insensitive and whitespace-tolerant; exact beats starts-with beats contains. Narrow with `--within "<landmark/heading/dialog name>"` and `--role <role>` (MCP: `within`, `role`). Not visible yet? The finder scrolls down up to 3 viewports before giving up.

## Action result

```
✓ done
+ heading "Order placed"
- button "Place order" [@e7hs02]
→ navigated https://shop.test/thanks
⧉ new tab 412
page: Thanks | https://shop.test/thanks | Thank you | 12 interactive
```

| Line | Meaning |
|---|---|
| `✓ done` / `✗ <status>: <detail>` | Outcome (see recovery.md) |
| `+ …` / `- …` | Snapshot lines that appeared / disappeared (indentation stripped) |
| `→ navigated <url>` | The action changed the URL |
| `⧉ new tab <id>` | A tab opened; it joins your session (`kite tab use <id>`) |
| `! <error>` | Visible form errors (with `disabled`) |
| `candidates:` | With `ambiguous`: `@ref line` per close match |
| `page:` | `<title> \| <url> \| <first h1> \| <n> interactive` |

An empty diff on `done` for fill/select/press/scroll is normal. An empty diff on a click is reported as `no_effect`.

## Console and network lines

- `kite console`: `[error] TypeError: x is undefined (app.js:12)`, oldest first. `--errors`, `--limit <n>`, `--clear`.
- `kite network`: `POST 500 http://localhost:3000/api/save (34 ms)`, or `GET ERR <url> net::ERR_FAILED`. `--failed`, `--filter <text>`, `--limit <n>`, `--clear`.
- Capture starts when the tab is opened or adopted, so open the tab before reproducing.
