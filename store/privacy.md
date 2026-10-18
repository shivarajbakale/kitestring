# Kitestring privacy policy

Last updated: 2026-10-18

Kitestring collects nothing and transmits nothing.

- **No data leaves your computer.** The extension talks only to the `kite` program running on the same computer, through Chrome's native messaging. It makes no network requests of its own, has no server, no account, no analytics and no crash reporting.
- **No model.** Kitestring never calls an AI model. If you connect an AI agent, that agent is a separate program you chose and configured; what it does with page content is governed by that agent's own terms.
- **Plans and the action cache stay on your machine.** Remembered plans are stored as files under `~/.kitestring/memory` (or `$KITE_HOME/memory`), and the action cache in the extension's `chrome.storage.local`. Plans hold parameter names, never the values you typed; password and one-time-code fields are never stored. You can delete them at any time with `kite memory forget <slug>` and `kite cache clear`.
- **Logs are local.** The activity list and host log are kept on your computer and record action names and file base names, not page contents.
- **Removal.** Removing the extension deletes its stored data. `kite uninstall-agents` removes the agent configuration; deleting `~/.kitestring` removes everything else.

Questions: open an issue on the project's repository.
