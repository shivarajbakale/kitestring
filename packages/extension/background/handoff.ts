import type { Handoff, HandoffResult } from "@kitestring/protocol"

/** chrome.storage.session key holding the open requests (read by the popup and side panel). */
export const HANDOFF_KEY = "kite.handoff"
const NOTIFICATION_PREFIX = "kite-handoff:"
const BADGE_COLOR = "#d63b1f"

/** One open request per session: an agent waits on one thing at a time. */
const open = new Map<string, Handoff>()
/** human.ask calls waiting on a session's request. */
const waiters = new Map<string, Set<(h: Handoff | null) => void>>()
let loaded: Promise<void> | null = null

/** Loads the persisted requests once (service-worker restart). */
export function ready(): Promise<void> {
  loaded ??= (async () => {
    const stored = (await chrome.storage.session.get(HANDOFF_KEY))[HANDOFF_KEY] as Handoff[] | undefined
    for (const h of stored ?? []) if (!open.has(h.session)) open.set(h.session, h)
  })().catch((e: unknown) => {
    loaded = null
    throw e
  })
  return loaded
}

/** Requests the person has not answered yet, oldest first. */
export function pending(): Handoff[] {
  return [...open.values()].filter((h) => !h.outcome).sort((a, b) => a.since - b.since)
}

async function save(): Promise<void> {
  await chrome.storage.session.set({ [HANDOFF_KEY]: [...open.values()] })
  // The badge is a nicety: never fail a request over it.
  const n = pending().length
  try {
    await chrome.action.setBadgeText({ text: n ? "!" : "" })
    if (n) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR })
  } catch {
    /* no action surface */
  }
}

function iconUrl(): string {
  const icons = (chrome.runtime.getManifest().icons ?? {}) as Record<string, string>
  const largest = Object.keys(icons).sort((a, b) => Number(b) - Number(a))[0]
  return largest ? chrome.runtime.getURL(icons[largest]!) : ""
}

function notify(h: Handoff): void {
  chrome.notifications.create(
    NOTIFICATION_PREFIX + h.session,
    {
      type: "basic",
      iconUrl: iconUrl(),
      title: `${h.session} needs you`,
      message: h.reason,
      buttons: [{ title: "Done" }, { title: "Can’t do it" }],
      requireInteraction: true,
      priority: 2,
    },
    () => {
      // Notifications turned off or refused: the badge and panel card still show it.
      const e = chrome.runtime.lastError
      if (e) console.warn("[kite] handoff notification not shown:", e.message)
    },
  )
}

function clearNotification(session: string): void {
  chrome.notifications.clear(NOTIFICATION_PREFIX + session, () => void chrome.runtime.lastError)
}

export async function focus(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true })
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
  } catch {
    /* tab closed since */
  }
}

const result = (h: Handoff, status: HandoffResult["status"]): HandoffResult => ({ status, reason: h.reason, since: h.since })

/**
 * Opens a request for the person (notification, badge, panel card, tab brought to the front), or keeps
 * waiting on the session's open one. Resolves when they answer, or `waiting` after `waitMs`.
 */
export async function ask(session: string, tabId: number | null, reason: string, waitMs: number): Promise<HandoffResult> {
  await ready()
  let h = open.get(session)
  if (h?.outcome) {
    // Answered between two calls: that answer belongs to the same question only.
    open.delete(session)
    await save()
    if (h.reason === reason) return result(h, h.outcome)
    h = undefined
  }
  if (h && h.reason !== reason) {
    // A new question replaces the open one: the person sees and answers what the agent needs now.
    for (const cb of [...(waiters.get(session) ?? [])]) cb(null)
    h = undefined
  }
  if (!h) {
    h = { session, tabId, reason, since: Date.now() }
    open.set(session, h)
    await save()
    notify(h)
    if (tabId !== null) void focus(tabId)
  }
  const asked = h
  const answered = await new Promise<Handoff | null>((resolve) => {
    if (waitMs <= 0) return resolve(null)
    const set = waiters.get(session) ?? new Set()
    waiters.set(session, set)
    const done = (x: Handoff | null) => {
      clearTimeout(timer)
      set.delete(done)
      if (!set.size) waiters.delete(session)
      resolve(x)
    }
    const timer = setTimeout(() => done(null), waitMs)
    set.add(done)
  })
  return answered?.outcome ? result(answered, answered.outcome) : result(asked, "waiting")
}

/** The person's answer. Handed straight to a waiting call, else kept for the agent's next human.ask. */
export async function answer(session: string, outcome: "done" | "declined"): Promise<void> {
  await ready()
  const h = open.get(session)
  if (!h || h.outcome) return
  h.outcome = outcome
  const w = waiters.get(session)
  if (w?.size) {
    open.delete(session)
    for (const cb of [...w]) cb(h)
  }
  clearNotification(session)
  await save()
}

const sessionOf = (notificationId: string): string | null =>
  notificationId.startsWith(NOTIFICATION_PREFIX) ? notificationId.slice(NOTIFICATION_PREFIX.length) : null

/** Call once at service-worker start: the notification's buttons answer, a click on it shows the tab. */
export function initHandoff(): void {
  chrome.notifications.onButtonClicked.addListener((id, button) => {
    const session = sessionOf(id)
    if (session !== null) void answer(session, button === 0 ? "done" : "declined")
  })
  chrome.notifications.onClicked.addListener((id) => {
    const session = sessionOf(id)
    if (session === null) return
    void ready().then(() => {
      const tabId = open.get(session)?.tabId
      if (tabId != null) void focus(tabId)
    })
  })
}
