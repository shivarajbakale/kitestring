import { focus, iconUrl } from "./handoff"

const PREFIX = "kite-notify:"
/** Notification id -> the tab a click on it shows. */
const tabs = new Map<string, number>()
let next = 0

/** A one-way message for the person (a scheduled run finished, or stopped); a click shows `tabId` when given. */
export function show(title: string, message: string, tabId?: number): void {
  const id = `${PREFIX}${Date.now()}-${next++}`
  if (tabId !== undefined) tabs.set(id, tabId)
  chrome.notifications.create(id, { type: "basic", iconUrl: iconUrl(), title, message, priority: 1 }, () => {
    const e = chrome.runtime.lastError
    if (e) console.warn("[kite] notification not shown:", e.message)
  })
}

/** Call once at service-worker start. */
export function initNotify(): void {
  chrome.notifications.onClicked.addListener((id) => {
    if (!id.startsWith(PREFIX)) return
    const tabId = tabs.get(id)
    tabs.delete(id)
    chrome.notifications.clear(id, () => void chrome.runtime.lastError)
    if (tabId !== undefined) void focus(tabId)
  })
  chrome.notifications.onClosed.addListener((id) => void tabs.delete(id))
}
