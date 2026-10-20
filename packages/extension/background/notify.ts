import { focus, iconUrl } from "./handoff"

const PREFIX = "kite-notify:"
/** Notification id -> the tab a click on it shows, or the URL it opens. */
const tabs = new Map<string, number>()
const urls = new Map<string, string>()
let next = 0

/** A one-way message for the person (a scheduled run finished, or stopped); a click shows `tabId`, or opens `url`. */
export function show(title: string, message: string, tabId?: number, url?: string): void {
  const id = `${PREFIX}${Date.now()}-${next++}`
  if (tabId !== undefined) tabs.set(id, tabId)
  else if (url !== undefined) urls.set(id, url)
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
    const url = urls.get(id)
    tabs.delete(id)
    urls.delete(id)
    chrome.notifications.clear(id, () => void chrome.runtime.lastError)
    if (tabId !== undefined) void focus(tabId)
    else if (url !== undefined) void chrome.tabs.create({ url, active: true }).catch(() => {})
  })
  chrome.notifications.onClosed.addListener((id) => {
    tabs.delete(id)
    urls.delete(id)
  })
}
