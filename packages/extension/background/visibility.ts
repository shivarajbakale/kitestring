import { send } from "./cdp"
import { isAgentWindow } from "./sessions"

/**
 * Chrome delivers no input to a hidden page: a tab that is not the one its window shows, a minimized window, or one off
 * screen (another desktop, behind a full-screen app). Clicks and scrolls then never complete.
 */
export async function pageHidden(tabId: number): Promise<boolean> {
  try {
    const r = await send<{ result: { value?: unknown } }>(tabId, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true })
    return r.result.value === "hidden"
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Makes a hidden tab the one its window shows, when that window is one Kitestring opened for a session (never the
 * person's own window: that would change what they are looking at) and is not minimized. True once the page is visible.
 */
export async function reveal(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (!tab || tab.active || !isAgentWindow(tab.windowId)) return false
  const win = await chrome.windows.get(tab.windowId).catch(() => undefined)
  if (!win || win.state === "minimized") return false
  await chrome.tabs.update(tabId, { active: true })
  for (let i = 0; i < 10; i++) {
    if (!(await pageHidden(tabId))) return true
    await sleep(100)
  }
  return false
}

/** Why the tab is hidden, and what to do about it. Always starts with "the tab is hidden". */
export async function hiddenDetail(tabId: number): Promise<string> {
  const end = "Chrome delivers no input to hidden tabs"
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  const win = tab ? await chrome.windows.get(tab.windowId).catch(() => undefined) : undefined
  if (tab && !tab.active) {
    return `the tab is hidden: another tab is selected in its window, and ${end}. Select it again (browser_tab_use), or ask the person to leave it selected while you work`
  }
  if (win?.state === "minimized") return `the tab is hidden: its window is minimized, and ${end}. Ask the person to restore the window`
  return `the tab is hidden: its window is not on screen (on another desktop, behind a full-screen app, or covered), and ${end}. Ask the person to bring the window onto this desktop`
}
