---
name: kitestring-debug-frontend
description: Use when a web UI misbehaves and the cause is not yet known - a button does nothing, a form will not submit, a page is blank or broken, data does not load, a console error or failed request is suspected, or a bug report describes something visible in the browser - and the app can be opened on localhost or a dev URL in the user's Chrome.
---

# Debug a frontend with Kitestring

**REQUIRED BACKGROUND:** the `kitestring` skill (loop, safety rules, recovery table).

## Overview

Reproduce the bug in the real browser, read what the browser recorded, then fix the code. **No fix before you have seen the failure and its evidence.** A guess from the source alone is not a diagnosis.

## Steps

1. **Open the tab first** (capture starts when the tab opens): `kite tab new http://localhost:3000/<page>` / `browser_tab_new`.
2. **Reproduce** the user's steps with the normal loop (`kite snapshot`, then `kite click` / `kite fill` / `kite select`). Write down the exact status and diff of the failing step.
3. **Collect evidence** right after the failure:
   - `kite console --errors` / `browser_console` with level `error`
   - `kite network --failed` / `browser_network` with `failed` (add `--filter /api` to narrow)
   - `kite snapshot` for state; `kite screenshot` only if the problem is visual
4. **Read the status before reading code.** `disabled` + error text = validation, not a broken handler. `blocked` = an overlay covers the control. `no_effect` = handler missing, throwing, or the request failed. See the `kitestring` recovery table.
5. **Find the cause in the code** that the evidence points to (stack file:line, failing endpoint, validation rule). Fix it.
6. **Re-verify**: `kite console --clear` and `kite network --clear`, then `kite goto <same url>` (reload), repeat the exact reproduction, and confirm: the step now returns `done` with the expected diff, no new console errors, no failed requests.

## Report

```
Bug: <what the user saw>
Reproduced: <steps> → <status + key diff/console/network lines>
Cause: <file:line, why>
Fix: <what changed>
Verified: <same steps> → <done + diff>; console clean; network clean
Not verified: <anything you could not check>
```

## Rules

- "It does nothing" is a symptom, not a cause. `disabled-until-valid`-style pages refuse clicks by design until inputs are valid: check the status detail before touching code.
- Do not "fix" by changing what the test clicks or by removing validation.
- Reproduce on localhost or a dev URL. On production or a logged-in real account, read only; ask the human before any action with consequences.
- Never claim fixed without step 6 output.
