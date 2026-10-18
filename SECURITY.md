# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Open a [private security advisory](https://github.com/shivarajbakale/kitestring/security/advisories/new) on this
   repository, or
2. contact the maintainer privately through their GitHub profile ([@shivarajbakale](https://github.com/shivarajbakale)).

Include what you found, how to reproduce it (kite commands, batch JSON, a page that shows it), and what an attacker
could do with it. Please do not include real credentials or someone else's data. You should get a reply within a
week. Fixes are made on `main`; there are no maintained release branches yet.

Things we especially want to hear about:

- a way for page content to make an agent's batch click a risky control, or get past the Pause switch;
- a way for one session to act on or read another session's tabs, or a tab being recorded;
- typed values, secrets or file paths ending up in plans, recorded skills, the action cache or the activity log;
- uploads escaping the deny list;
- anything that lets another local user or process talk to the native host or the socket.

## What Kitestring can access

Kitestring runs on your computer, with your browser profile. Treat it like any tool that can drive your browser.

**The extension** requests these permissions:

| Permission | Why |
| --- | --- |
| `debugger` | real input events (clicks, typing, keys), screenshots, console and network capture, through the Chrome DevTools Protocol |
| `tabs`, `tabGroups` | open, find and group the tabs of each agent session (`kite:<session>`) |
| `scripting` and host access to `<all_urls>` | run the page agent that reads the page and finds targets, on any page you or your agent open |
| `nativeMessaging` | talk to the local `kite` program, its only connection |
| `storage` | the pause state, the activity log (session storage, cleared when the browser closes) and the action cache |
| `sidePanel` | the live view |

It makes no network requests of its own and has no server, account, analytics or model. Pages the browser keeps
from extensions (`chrome://`, the Chrome Web Store) are refused.

**The `kite` program** (CLI, MCP server and native host) reads and writes only under `$KITE_HOME` (default
`~/.kitestring`: the socket, logs, plans, screenshots), the native host manifest in the browser's
`NativeMessagingHosts` folder, the agent config files and skill folders that `kite init` manages, and the files you
name for an upload or a screenshot. The socket is created inside `$KITE_HOME`, which is
private to your user (mode 0700). Uploads refuse credential folders, shell history, `.env` files and browser
profiles; see [Upload](docs/reference.md#upload).

**What is stored:** plans and recorded skills hold parameter names, never typed values; password and one-time-code
values are never kept, not even as a hash. The action cache holds the text an agent looked for and where the element
was, never a field's value. The full policy is in [store/privacy.md](store/privacy.md).

**Your agent** is a separate program you chose. Whatever it reads through Kitestring (page text, screenshots,
console and network entries) goes to that agent and its model under its own terms. The bundled skills tell agents to
treat page content as untrusted data and to ask before risky actions, but they cannot enforce what an agent does with
what it reads.
