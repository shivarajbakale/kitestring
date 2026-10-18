import {
  ErrorCode,
  findEcho,
  pathPattern,
  type PlanParam,
  type PlanStep,
  type RecordEcho,
  type RecordedEvent,
  type Recording,
  type RecorderState,
} from "@kitestring/protocol"
import { messageTab } from "./agent-bridge"
import { RpcError } from "./errors"

/** chrome.storage.session key (memory only, never on disk) holding the recording in progress; read by the side panel. */
export const RECORDING_KEY = "kite.recording"
/** A URL change this soon after a recorded step was caused by it: the step gets `expect: {url}`. */
const NAV_WINDOW_MS = 10_000

/** Background -> content script. */
export type RecorderCommand = { kiteRecord: "start"; state: RecorderState } | { kiteRecord: "stop" }
/** Content script -> background. */
export type RecorderMessage = { kiteRecord: "event"; event: RecordedEvent }

interface Rec {
  name: string
  tabId: number
  /** Origin + path where recording started (no query or fragment). */
  url: string
  steps: PlanStep[]
  params: PlanParam[]
  /** Hashes of the non-secret values typed so far (never the values). */
  echoes: RecordEcho[]
  /** False once stopped from the side panel or the tab closed: the steps wait for `kite record stop`. */
  active: boolean
  lastStepAt: number
  /** Origin + path pattern the tab is on, to tell a navigation from a reload or a query change. */
  at: string
}

let rec: Rec | null = null
let loaded: Promise<void> | undefined
/** Every operation runs in order, after the state is loaded (a service worker can restart mid-recording). */
let chain: Promise<unknown> = Promise.resolve()

function load(): Promise<void> {
  loaded ??= chrome.storage.session.get(RECORDING_KEY).then((r) => {
    rec = (r[RECORDING_KEY] as Rec | undefined) ?? null
  })
  return loaded
}

function run<T>(fn: () => T | Promise<T>): Promise<T> {
  const p = chain.then(load).then(fn)
  chain = p.catch(() => {})
  return p
}

/** Resolves once the state is loaded and every queued event, navigation and write has been applied. */
export async function ready(): Promise<void> {
  await run(() => {})
}

const persist = (): Promise<void> =>
  rec ? chrome.storage.session.set({ [RECORDING_KEY]: rec }) : chrome.storage.session.remove(RECORDING_KEY)

const location = (url: string): string => {
  try {
    return new URL(url).origin + pathPattern(url)
  } catch {
    return pathPattern(url)
  }
}

const stripQuery = (url: string): string => {
  try {
    const u = new URL(url)
    return u.origin + u.pathname
  } catch {
    return url.split(/[?#]/)[0] ?? url
  }
}

function decodeSeg(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/**
 * `expect.url` for a navigation to `url`: its path pattern (a substring match), or, when a segment is an id or echoes a
 * typed value, a regex over scheme, host and path with those segments as wildcards.
 */
export function expectUrl(url: string, echoes: readonly RecordEcho[]): string {
  const segs = pathPattern(url)
    .split("/")
    .map((s) => (s && (s === "*" || findEcho(decodeSeg(s), echoes)) ? "*" : s))
  if (!segs.includes("*")) return segs.join("/")
  const re = segs.map((s) => (s === "*" ? "[^/?#]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")
  return `/^[^:/]+://[^/]+${re}(?:[?#]|$)/`
}

const stateOf = (r: Rec): RecorderState => ({ used: r.params.map((p) => p.name), echoes: r.echoes })

async function arm(r: Rec): Promise<void> {
  await messageTab(r.tabId, { kiteRecord: "start", state: stateOf(r) } satisfies RecorderCommand)
}

async function disarm(r: Rec): Promise<void> {
  try {
    await messageTab(r.tabId, { kiteRecord: "stop" } satisfies RecorderCommand)
  } catch {
    // tab gone or page unscriptable: nothing is listening anyway
  }
}

/** Starts recording the human's actions in `tabId`. One recording at a time. */
export function startRecording(tabId: number, name: string): Promise<{ name: string; tab: number; url: string }> {
  return run(async () => {
    if (rec) {
      throw new RpcError(
        ErrorCode.BAD_REQUEST,
        rec.active
          ? `already recording ${rec.name} in tab ${rec.tabId}: run kite record stop first`
          : `recording ${rec.name} was stopped but not saved: run kite record stop first`,
      )
    }
    const tab = await chrome.tabs.get(tabId)
    const full = tab.url || tab.pendingUrl || ""
    const r: Rec = { name, tabId, url: stripQuery(full), steps: [], params: [], echoes: [], active: true, lastStepAt: 0, at: location(full) }
    await arm(r) // throws for a restricted page: nothing is recorded
    rec = r
    await persist()
    return { name, tab: tabId, url: r.url }
  })
}

/** Ends the recording (or collects one stopped from the panel) and hands back its steps. No values are in it. */
export function stopRecording(): Promise<Recording> {
  return run(async () => {
    const r = rec
    if (!r) throw new RpcError(ErrorCode.BAD_REQUEST, "not recording: start with kite record start --name <name>")
    if (r.active) await disarm(r)
    rec = null
    await persist()
    return { name: r.name, url: r.url, steps: r.steps, secrets: r.params.filter((p) => p.secret).map((p) => p.name) }
  })
}

/** The side panel's Stop: no more steps are taken; `kite record stop` still collects them. */
export function stopFromPanel(): Promise<void> {
  return run(async () => {
    if (!rec?.active) return
    rec.active = false
    await disarm(rec)
    await persist()
  })
}

/** True while `tabId` is being recorded (agents do not act in it). Call after `ready()`. */
export function isRecording(tabId: number | null): boolean {
  return !!rec?.active && rec.tabId === tabId
}

export function recordingStatus(): { name: string; active: boolean } | null {
  return rec ? { name: rec.name, active: rec.active } : null
}

const isStr = (v: unknown): v is string => typeof v === "string"

function validEvent(e: unknown): e is RecordedEvent {
  const ev = e as RecordedEvent | null
  return (
    !!ev &&
    typeof ev.step === "object" &&
    ev.step !== null &&
    isStr((ev.step as { action?: unknown }).action) &&
    Array.isArray(ev.params) &&
    ev.params.every((p) => isStr(p?.name) && typeof p.secret === "boolean") &&
    Array.isArray(ev.echoes) &&
    ev.echoes.every((x) => typeof x?.h === "number" && typeof x.n === "number" && isStr(x.param))
  )
}

function onEvent(event: RecordedEvent, tabId: number | undefined): void {
  void run(async () => {
    if (!rec?.active || tabId !== rec.tabId) return
    rec.steps.push(event.step)
    rec.params.push(...event.params)
    rec.echoes.push(...event.echoes)
    rec.lastStepAt = Date.now()
    await persist()
  })
}

function onTabUpdated(tabId: number, change: chrome.tabs.TabChangeInfo): void {
  if (change.url === undefined && change.status !== "complete") return
  void run(async () => {
    const r = rec
    if (!r?.active || tabId !== r.tabId) return
    if (change.url !== undefined && location(change.url) !== r.at) {
      r.at = location(change.url)
      const last = r.steps.at(-1)
      if (last && last.action !== "fill" && !last.expect && Date.now() - r.lastStepAt < NAV_WINDOW_MS) {
        last.expect = { url: expectUrl(change.url, r.echoes) }
      }
      await persist()
    }
    if (change.status === "complete") {
      // a new document: its recorder starts with the params in use and the echoes of earlier values
      await arm(r).catch(() => {})
    }
  })
}

function onTabRemoved(tabId: number): void {
  void run(async () => {
    if (!rec?.active || rec.tabId !== tabId) return
    rec.active = false
    await persist()
  })
}

/** Call once at service-worker start. */
export function listenRecorder(): void {
  chrome.runtime.onMessage.addListener((m: unknown, sender) => {
    const msg = m as Partial<RecorderMessage> | null
    if (msg?.kiteRecord !== "event" || sender.id !== chrome.runtime.id || sender.frameId !== 0) return false
    if (validEvent(msg.event)) onEvent(msg.event, sender.tab?.id)
    return false
  })
  chrome.tabs.onUpdated.addListener(onTabUpdated)
  chrome.tabs.onRemoved.addListener(onTabRemoved)
}
