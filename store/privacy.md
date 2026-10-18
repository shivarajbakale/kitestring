# Kitestring privacy policy

Last updated: 2026-10-18

Kitestring collects nothing and transmits nothing.

- **No data leaves your computer.** The extension talks only to the `kite` program running on the same computer, through Chrome's native messaging. It makes no network requests of its own, has no server, no account, no analytics and no crash reporting.
- **A page helper that answers only when asked.** A small content script is loaded on every page so it is ready when you or your agent act. It answers requests relayed by the extension from the local `kite` program, and otherwise reads and sends nothing.
- **Recording is yours to start.** `kite record start` records one tab. While it runs, the page helper in that tab watches your clicks and field changes and keeps only parameterized steps: typed values become parameters and leave the page only as salted hashes (in session memory, used to keep them out of later steps), and password, card and one-time-code values are not even hashed. Agents cannot act in or read that tab until you stop.
- **No model.** Kitestring never calls an AI model. If you connect an AI agent, that agent is a separate program you chose and configured; what it does with page content is governed by that agent's own terms.
- **Plans and the action cache stay on your machine.** Remembered plans are stored as files under `~/.kitestring/memory` (or `$KITE_HOME/memory`), and the action cache in the extension's `chrome.storage.local`. Plans hold parameter names, never the values you typed; password and one-time-code values are never stored. The action cache holds the text an agent looked for and where the matching element was, never a field's value. You can delete them at any time with `kite memory forget <slug>` and `kite cache clear`.
- **Logs are local.** The activity list is kept in the extension's session storage and cleared when the browser closes. Its entries hold what each action targeted (element names, URLs, upload file base names) and a page summary and diff, with typed values redacted. The `kite` host log on your computer records only start-up, shutdown and errors.
- **Removal.** Removing the extension deletes its stored data. `kite uninstall-agents` removes the agent configuration; deleting `~/.kitestring` removes everything else.

Questions: open an issue on the project's repository.
