import type { GroupColor, UiRequest, UiResponse, UiSession, UiState } from "../ui/messages"
import { isTrustedUiSender, parseUiRequest } from "../ui/messages"
import * as activity from "./activity"
import * as control from "./control"
import * as handoff from "./handoff"
import { isHostConnected } from "./native-port"
import * as recorder from "./recorder"
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
  await Promise.all([sessions.loadSessions(), control.ready(), activity.ready(), recorder.ready(), handoff.ready()])
  const log = activity.list()
  const list: UiSession[] = []
  for (const name of sessions.sessionNames()) {
    const s = sessions.findSession(name)!
    const lastActivity = log.find((e) => e.session === name)
    list.push({ name, color: await groupColor(s), tabCount: s.tabs.size, ...(lastActivity ? { lastActivity } : {}) })
  }
  const { paused, reason, since } = control.getState()
  const recording = recorder.recordingStatus()
  return {
    hostConnected: isHostConnected(),
    paused,
    ...(reason ? { reason } : {}),
    ...(since ? { since } : {}),
    sessions: list,
    ...(recording ? { recording } : {}),
    handoffs: handoff.pending().map(({ session, reason, since, tabId }) => ({ session, reason, since, tabId })),
  }
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true })
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
}

async function focusSession(name: string, preferTabId?: number): Promise<void> {
  if (preferTabId !== undefined) {
    try {
      return await focusTab(preferTabId)
    } catch {
      // tab closed since; fall back to the session's current tab
    }
  }
  await sessions.loadSessions()
  const s = sessions.findSession(name)
  if (!s) throw new Error(`no session "${name}"`)
  const tabId = s.activeTabId ?? [...s.tabs][0]
  if (tabId === undefined) throw new Error(`session "${name}" has no tabs`)
  await focusTab(tabId)
}

async function handle(req: UiRequest): Promise<UiState> {
  switch (req.op) {
    case "state":
      break
    case "pause":
      await control.ready()
      await control.pause(req.reason)
      break
    case "resume":
      await control.ready()
      await control.resume()
      break
    case "focusTab":
      await focusSession(req.session, req.tabId)
      break
    case "handoff":
      await handoff.answer(req.session, req.outcome)
      break
    case "recordStop":
      await recorder.stopFromPanel()
      break
    case "openPanel": {
      const windowId = req.windowId ?? (await chrome.windows.getLastFocused()).id!
      await chrome.sidePanel.open({ windowId })
      break
    }
  }
  return uiState()
}

/**
 * Call once at service-worker start: answers `{kite: "ui", op}` messages from the popup and side panel.
 * `openPanel` is kept for pages that can't call chrome.sidePanel.open themselves; the popup opens the
 * panel directly so the click's user gesture is never lost.
 */
export function listenUi(): void {
  chrome.runtime.onMessage.addListener((m: unknown, sender, sendResponse: (r: UiResponse) => void) => {
    if (!isTrustedUiSender(sender, chrome.runtime.id, chrome.runtime.getURL(""))) return false
    const req = parseUiRequest(m)
    if (!req) {
      if ((m as { kite?: unknown } | null)?.kite === "ui") sendResponse({ ok: false, error: "malformed ui request" })
      return false
    }
    handle(req).then(
      (state) => sendResponse({ ok: true, state }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    )
    return true // answered asynchronously
  })
}
