import type { GroupColor, UiRequest, UiResponse, UiSession, UiState } from "../ui/messages"
import { isUiRequest } from "../ui/messages"
import * as activity from "./activity"
import * as control from "./control"
import { isHostConnected } from "./native-port"
import * as sessions from "./sessions"

async function groupColor(s: sessions.Session): Promise<GroupColor> {
  if (s.groupId !== null) {
    try {
      return (await chrome.tabGroups.get(s.groupId)).color as GroupColor // the user may have recolored it
    } catch {
      // group gone; fall through
    }
  }
  return sessions.colorOf(s) as GroupColor
}

export async function uiState(): Promise<UiState> {
  await Promise.all([sessions.loadSessions(), control.ready(), activity.ready()])
  const log = activity.list()
  const list: UiSession[] = []
  for (const name of sessions.sessionNames()) {
    const s = sessions.findSession(name)!
    const lastActivity = log.find((e) => e.session === name)
    list.push({ name, color: await groupColor(s), tabCount: s.tabs.size, ...(lastActivity ? { lastActivity } : {}) })
  }
  const { paused, reason, since } = control.getState()
  return {
    hostConnected: isHostConnected(),
    paused,
    ...(reason ? { reason } : {}),
    ...(since ? { since } : {}),
    sessions: list,
  }
}

async function focusSession(name: string): Promise<void> {
  await sessions.loadSessions()
  const s = sessions.findSession(name)
  if (!s) throw new Error(`no session "${name}"`)
  const tabId = s.activeTabId ?? [...s.tabs][0]
  if (tabId === undefined) throw new Error(`session "${name}" has no tabs`)
  const tab = await chrome.tabs.update(tabId, { active: true })
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
}

async function handle(req: UiRequest): Promise<UiState> {
  switch (req.op) {
    case "state":
      break
    case "pause":
      await control.ready()
      await control.pause(req.reason?.trim() || undefined)
      break
    case "resume":
      await control.ready()
      await control.resume()
      break
    case "focusTab":
      await focusSession(req.session)
      break
    case "openPanel": {
      const windowId = req.windowId ?? (await chrome.windows.getLastFocused()).id!
      await chrome.sidePanel.open({ windowId })
      break
    }
  }
  return uiState()
}

/** Call once at service-worker start: answers `{kite: "ui", op}` messages from the popup and side panel. */
export function listenUi(): void {
  chrome.runtime.onMessage.addListener((m: unknown, sender, sendResponse: (r: UiResponse) => void) => {
    if (!isUiRequest(m) || sender.id !== chrome.runtime.id) return false
    handle(m).then(
      (state) => sendResponse({ ok: true, state }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    )
    return true // answered asynchronously
  })
}
