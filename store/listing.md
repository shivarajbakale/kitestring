# Chrome Web Store listing

## Name

Kitestring

## Summary (max 132 characters)

Your AI agent drives your real Chrome and replays tasks done before. The extension sends nothing anywhere; your agent decides.

## Description

Kitestring lets the AI agent you already use (Claude Code, Codex, Cursor, Gemini CLI, OpenCode) drive your real Chrome: your profile, your logins, your tabs. You can drive it from a terminal too, with the `kite` command.

It needs the free `kite` program on the same computer. The extension talks only to that program, through Chrome's native messaging. It has no server, no account and no model of its own: your agent does the planning.

What it does
- Safe actions. Every click, fill and key press finds the target by name, checks that nothing covers it, acts with real input events, waits for the page to settle and reports what changed.
- Batches. A whole form in one call, stopping at the first thing that does not work and saying where.
- Guards. Risky buttons (pay, buy, delete, publish) halt a batch. Dialogs, cookie walls and new tabs are handled. A domain guard keeps a run on the site it started on.
- Speed on repeat tasks. Plans your agent has run before, or tasks you recorded once, replay as one call with no model involved, instead of an agent turn per page.
- You stay in control. A Pause switch, per-agent tab groups, a live view of everything agents do, and a refusal to touch pages the browser keeps from extensions.

Setup: install this extension, then run `kite init` (see the project page) to connect your agents.

## Category

Developer Tools

## Language

English

## Single purpose

Kitestring lets the user's own AI agent or command line operate the user's browser tabs on their behalf, through the local `kite` program.

## Permission justifications

- `debugger`: Sends real mouse and keyboard input to the tab an agent is working on and reads its accessibility tree, so actions behave like a person's. Chrome shows its "started debugging this browser" bar while this is in use.
- `nativeMessaging`: The only channel to the local `kite` program on the same computer. The extension has no other way to receive requests or send results.
- `tabs`: Lists, opens, selects and closes the tabs of the agent's session, and reads a tab's URL and title to report them and to enforce the domain guard.
- `tabGroups`: Puts each agent session's tabs in its own group (`kite:<session>`) so the user can see which tabs an agent owns.
- `scripting`: A small page helper is declared as a content script on all pages (`<all_urls>`, `document_idle`). It answers only when asked: it reads a page when the local `kite` program asks for it in a tab an agent session owns. While the user records a task with `kite record start`, it watches that one tab's clicks and field changes and sends parameterized steps (typed values leave the page only as salted hashes; secret fields' values not at all). `scripting` is the fallback that injects the same helper into tabs that were already open before the extension was installed or updated.
- `storage`: `chrome.storage.session` holds the Pause state, the agent sessions, an active recording's parameterized steps and the activity log (what each action targeted, its page summary and page diff, with typed values redacted), and is cleared when the browser closes. `chrome.storage.local` holds only the action cache: for pages agents have driven, the text an agent looked for and where the matching element was (its role, accessible name and position in the page). It never holds what was typed into a field, and it skips password, card and one-time-code fields, picked options (list, menu, tree and grid choices) and any target filled from a remembered plan's parameters.
- `sidePanel`: Shows the live view of what agents are doing in the browser side panel.
- `<all_urls>` (host permissions): The user decides which sites an agent works on, so the extension cannot know them in advance. The content script is present on every page but answers only when asked; actions run only on a tab an agent session owns, and never on pages the browser restricts.

## Data usage

Does not collect or transmit user data. See `privacy.md`.

## Screenshots

`store/screenshots/` (1280x800), refreshed with `KITE_UPDATE_DOCS=1 pnpm exec playwright test store-shots` from `e2e/`.
