---
name: kitestring-e2e-verify
description: Use when a code change affects anything a user sees or does in a web app (UI, forms, routing, API the UI calls) and you are about to say it works, mark a task done, or open a PR - and the app can run on localhost or a dev URL in the user's Chrome.
---

# Verify a change end to end with Kitestring

**REQUIRED BACKGROUND:** the `kitestring` skill (loop, safety rules, recovery table).

## Overview

Tests passing is not "the feature works". Drive the actual user flow in the real browser and claim only what you saw.

## Steps

1. **Define the flow and outcomes before driving.** Write the user steps and, for each, the visible outcome that proves it worked (a heading appears, a row is added, URL changes, a button becomes enabled).
2. **Start the app**, then `kite tab new <dev url>` / `browser_tab_new`.
3. **Drive every step** with the loop: one `kite snapshot` per new page, then the steps by visible text. Steps you can predict go in one `kite batch` / `browser_batch` (form fills plus the submit), with `expect` on the step that should change the page:
   ```
   echo '[{"action":"fill","target":"Email","value":"test@example.com"},{"action":"click","target":"Save","expect":{"text":"Saved"}}]' | kite batch -
   ```
4. **Assert from each result**, not from memory:
   - status is `done` (a batch: every step `✓`, no `halted` line)
   - the `+` / `-` lines or `→ navigated` contain the expected outcome
   - anything else is a failure: record it, do not "fix the test".
   Plain text (toasts, paragraphs) is not in snapshots: check it with `kite screenshot`.
5. **Check health** after the last action of the flow: `kite console --errors` and `kite network --failed` must be empty (or explained).
6. **Capture evidence**: `kite screenshot` of the final state (and of any failure). The command prints the file path.
7. **Cover the edges the change touches**: one invalid input, one empty state, one navigation back, as relevant.

## Report

```
Flow: <steps>
Verified:
- <step> → done, saw `+ heading "Order placed"` (screenshot: <path>)
Console/network: clean | <lines>
Not verified: <steps skipped, flows not covered, why>
```

The **Not verified** list is required, even if empty ("none"). Never write "works" for a step you did not drive.

## Rules

- If `kite` is not found, use the `browser_*` MCP tools and ask the human to run `kite doctor`.
- A step that returned anything but `done` is not verified. In a batch, a step after a `halted` line did not run: fix, resend from `next`, and report only what you saw. A `timeout` is not a pass.
- Use obviously fake test data (`test@example.com`) and list it in the report. Submits on localhost / dev URLs are fine.
- End with the Report block above, always, even when the verdict is "not ready" (say why: the failing step or error line).
- On real accounts and production: read only, and follow the confirm rule in the `kitestring` skill for anything with consequences.
- Flows behind a login: ask the human to sign in in that tab, then continue. Never type credentials or codes yourself, not even fake dev/test credentials.
