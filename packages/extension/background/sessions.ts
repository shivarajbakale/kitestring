import { ErrorCode } from "@kitestring/protocol"
import { isRestrictedUrl } from "./agent-bridge"
import { ensureAttached, onEvent, send } from "./cdp"
import { RpcError } from "./errors"

export interface Session {
  name: string
  groupId: number | null
  activeTabId: number | null
  tabs: Set<number>
  /** tabId -> the tab that opened it (popups, target=_blank). */
  opener: Map<number, number>
  /** tabId -> epoch ms when the watcher adopted it. */
  adoptedAt: Map<number, number>
}

export interface TabInfo {
  id: number
  url: string
  title: string
  active?: boolean
}

interface StoredSession {
  name: string
  groupId: number | null
  activeTabId: number | null
  tabs: number[]
  opener?: [number, number][]
  adoptedAt?: [number, number][]
}

const STORAGE_KEY = "kite.sessions"
const LOAD_TIMEOUT_MS = 10_000
const GROUP_COLORS: chrome.tabGroups.ColorEnum[] = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"]

/** Sessions in creation order (the order decides the group color). */
const sessions = new Map<string, Session>()

let loaded: Promise<void> | null = null

/** Reloads persisted state (service-worker restart) and drops tabs that no longer exist. */
export function loadSessions(): Promise<void> {
  loaded ??= (async () => {
    const stored = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY] as StoredSession[] | undefined
    const live = new Set((await chrome.tabs.query({})).map((t) => t.id))
    for (const s of stored ?? []) {
      const tabs = new Set(s.tabs.filter((id) => live.has(id)))
      sessions.set(s.name, {
        name: s.name,
        groupId: tabs.size ? s.groupId : null,
        activeTabId: s.activeTabId !== null && tabs.has(s.activeTabId) ? s.activeTabId : null,
        tabs,
        opener: new Map((s.opener ?? []).filter(([id]) => tabs.has(id))),
        adoptedAt: new Map((s.adoptedAt ?? []).filter(([id]) => tabs.has(id))),
      })
    }
  })().catch((e: unknown) => {
    loaded = null // a transient failure must not be cached: the next request retries
    throw e
  })
  return loaded
}

function persist(): Promise<void> {
  const data: StoredSession[] = [...sessions.values()].map((s) => ({
    name: s.name,
    groupId: s.groupId,
    activeTabId: s.activeTabId,
    tabs: [...s.tabs],
    opener: [...s.opener],
    adoptedAt: [...s.adoptedAt],
  }))
  return chrome.storage.session.set({ [STORAGE_KEY]: data })
}

export function sessionNames(): string[] {
  return [...sessions.keys()]
}

export function findSession(name: string): Session | undefined {
  return sessions.get(name)
}

/** A throwaway, unregistered session (owns nothing). */
export function emptySession(name: string): Session {
  return { name, groupId: null, activeTabId: null, tabs: new Set(), opener: new Map(), adoptedAt: new Map() }
}

export function getOrCreateSession(name: string): Session {
  let s = sessions.get(name)
  if (!s) {
    s = emptySession(name)
    sessions.set(name, s)
  }
  return s
}

/** The color the session's tab group is created with. */
export function colorOf(s: Session): chrome.tabGroups.ColorEnum {
  const i = [...sessions.keys()].indexOf(s.name)
  return GROUP_COLORS[Math.max(i, 0) % GROUP_COLORS.length]!
}

export function assertOwner(s: Session, tabId: number): void {
  if (!s.tabs.has(tabId)) {
    throw new RpcError(ErrorCode.NOT_OWNER, `NOT_OWNER: tab ${tabId} does not belong to session "${s.name}"`)
  }
}

/** The session's active tab, or NO_TAB. */
export function activeTab(s: Session): number {
  if (s.activeTabId === null) {
    throw new RpcError(ErrorCode.NO_TAB, `NO_TAB: session "${s.name}" has no active tab (run: kite tab new <url>)`)
  }
  return s.activeTabId
}

function waitForLoad(tabId: number, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
      resolve()
    }
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") done()
    }
    const onRemoved = (id: number) => {
      if (id === tabId) done()
    }
    const timer = setTimeout(done, timeoutMs)
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)
    chrome.tabs.get(tabId).then(
      (t) => {
        if (t.status === "complete" && !t.pendingUrl) done()
      },
      () => done(),
    )
  })
}

async function addToGroup(s: Session, tabId: number): Promise<void> {
  if (s.groupId !== null) {
    try {
      await chrome.tabs.group({ groupId: s.groupId, tabIds: [tabId] })
      return
    } catch {
      s.groupId = null // the group disappeared (e.g. the user closed all its tabs)
    }
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] })
  await chrome.tabGroups.update(groupId, { title: `kite:${s.name}`, color: colorOf(s) })
  s.groupId = groupId
}

const info = (t: chrome.tabs.Tab): TabInfo => ({ id: t.id!, url: t.url || t.pendingUrl || "", title: t.title ?? "" })

/**
 * Opens the tab on about:blank, attaches the debugger (capture starts) and only then navigates, so the
 * first load's console and network traffic is captured. Falls back to opening the URL directly when the
 * debugger can't attach.
 */
export async function newTab(s: Session, url?: string): Promise<TabInfo> {
  const target = url && !isRestrictedUrl(url) ? url : undefined
  const tab = await chrome.tabs.create({ url: target ? "about:blank" : (url ?? "about:blank"), active: true })
  const id = tab.id!
  s.tabs.add(id)
  s.activeTabId = id
  await persist()
  await addToGroup(s, id)
  await persist()
  let navigated = false
  if (target) {
    try {
      await ensureAttached(id)
      const loaded = waitLoadEvent(id, LOAD_TIMEOUT_MS)
      await send(id, "Page.navigate", { url: target })
      await loaded
      navigated = true
    } catch (e) {
      console.warn("[kite] tab.new: debugger navigation failed, opening the URL directly", e)
    }
    if (!navigated) await chrome.tabs.update(id, { url: target })
  } else {
    void ensureAttached(id).catch(() => {}) // restricted page: nothing to capture
  }
  await waitForLoad(id)
  return info(await chrome.tabs.get(id))
}

function waitLoadEvent(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      off()
      resolve()
    }
    const off = onEvent(tabId, (e) => {
      if (e.method === "Page.loadEventFired") done()
    })
    const timer = setTimeout(done, timeoutMs)
  })
}

/** Adds a tab the session's page opened (popup, target=_blank) to the session and its group. */
export async function adoptTab(s: Session, tabId: number, opts: { opener?: number; group?: boolean } = {}): Promise<void> {
  if (s.tabs.has(tabId)) return
  s.tabs.add(tabId)
  s.adoptedAt.set(tabId, Date.now())
  if (opts.opener !== undefined) s.opener.set(tabId, opts.opener)
  await persist()
  if (opts.group === false) return
  await addToGroup(s, tabId)
  await persist()
}

/** The most recently adopted tab, optionally only those adopted after epoch ms `since`. */
export function newestAdopted(s: Session, since = -1): number | undefined {
  let best: number | undefined
  let bestAt = since
  for (const [id, at] of s.adoptedAt) {
    if (s.tabs.has(id) && at > bestAt) {
      best = id
      bestAt = at
    }
  }
  return best
}

export function openerOf(s: Session, tabId: number): number | undefined {
  return s.opener.get(tabId)
}

export async function useTab(s: Session, tabId: number): Promise<TabInfo> {
  assertOwner(s, tabId)
  const tab = await chrome.tabs.update(tabId, { active: true })
  s.activeTabId = tabId
  await persist()
  void ensureAttached(tabId).catch(() => {}) // start capturing; restricted pages just stay unattached
  return info(tab ?? (await chrome.tabs.get(tabId)))
}

/** Closes `tabId`, or the session's active tab when omitted. */
export async function closeTab(s: Session, tabId?: number): Promise<void> {
  const id = tabId ?? activeTab(s)
  assertOwner(s, id)
  forget(id)
  await persist()
  await chrome.tabs.remove(id)
}

export async function listTabs(s: Session): Promise<TabInfo[]> {
  const out: TabInfo[] = []
  for (const id of s.tabs) {
    try {
      out.push({ ...info(await chrome.tabs.get(id)), ...(id === s.activeTabId ? { active: true } : {}) })
    } catch {
      // closed in the meantime; onRemoved will clean up
    }
  }
  return out
}

/** Removes a tab from whichever session owns it. Returns true if state changed. */
function forget(tabId: number): boolean {
  let changed = false
  for (const s of sessions.values()) {
    if (!s.tabs.delete(tabId)) continue
    changed = true
    const opener = s.opener.get(tabId)
    if (s.activeTabId === tabId) s.activeTabId = opener !== undefined && s.tabs.has(opener) ? opener : null
    s.opener.delete(tabId)
    s.adoptedAt.delete(tabId)
    if (s.tabs.size === 0) s.groupId = null
  }
  return changed
}

/** Call once at service-worker start: keeps sessions in sync with tabs the user closes. */
export function watchTabs(): void {
  // Tabs opened by a session's tab join that session (at any time, not only during an action).
  chrome.tabs.onCreated.addListener((tab) => {
    const openerId = tab.openerTabId
    if (openerId === undefined || tab.id === undefined) return
    const id = tab.id
    void loadSessions().then(async () => {
      const s = [...sessions.values()].find((x) => x.tabs.has(openerId))
      if (!s || s.tabs.has(id)) return
      // Tab groups are per window: a popup window's tab is owned but never grouped.
      const opener = await chrome.tabs.get(openerId).catch(() => undefined)
      await adoptTab(s, id, { opener: openerId, group: !!opener && opener.windowId === tab.windowId })
    })
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    void loadSessions().then(() => {
      if (forget(tabId)) return persist()
    })
  })
}
