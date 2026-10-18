import type { ErrorCode } from "./rpc.js"

export type Status =
  | "done"
  | "not_found"
  | "ambiguous"
  | "blocked"
  | "disabled"
  | "no_effect"
  | "timeout"
  | "restricted"
  | "error"

export interface Diff {
  added: string[]
  removed: string[]
}

export interface Candidate {
  ref: string
  line: string
  score: number
}

export interface DialogEvent {
  type: "alert" | "confirm" | "prompt" | "beforeunload"
  message: string
  handled: "accepted" | "dismissed"
}

export interface ActionResult {
  ok: boolean
  status: Status
  detail?: string
  diff: Diff
  navigation?: { url: string; title: string }
  newTabs?: number[]
  errors?: string[]
  candidates?: Candidate[]
  blockedBy?: string
  dialogs?: DialogEvent[]
  page: string
}

/** One recorded call (tab.new, tab.close, page.goto, act.*), as kept in chrome.storage.session `activity`. */
export interface ActivityEntry {
  /** Increasing; newer entries have larger ids. */
  id: number
  /** Epoch ms when the call finished. */
  ts: number
  session: string
  /** null when the call failed before a tab was known. */
  tabId: number | null
  method: string
  /** What was acted on: `"text"`, a ref, a key, a URL, a scroll direction. Never a filled value. */
  target?: string
  /** ActionResult status, or the RPC error code when the call failed. */
  status: Status | ErrorCode
  ms: number
  url?: string
  /** `✓ done +N/−M`, `✗ blocked: … +N/−M`, `✗ PAUSED: …`. */
  summary: string
  /** At most 20 lines each. */
  diff?: Diff
  /** Page brief after the action, at most 2000 chars. */
  page?: string
  /** Id shared by all steps of one batch. */
  batch?: number
}

export interface ControlState {
  paused: boolean
  reason?: string
  /** Epoch ms of the last pause/resume. */
  since?: number
}

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug"

export interface ConsoleEntry {
  ts: number
  level: ConsoleLevel
  text: string
  url?: string
  line?: number
  /** Count of main-frame navigations seen since capture started (entries of older pages have smaller values). */
  nav: number
}

export interface NetworkEntry {
  ts: number
  method: string
  url: string
  status?: number
  /** CDP resource type: Document, Fetch, XHR, Script, ... */
  type: string
  ms?: number
  failed: boolean
  error?: string
  nav: number
}

export interface ScreenshotResult {
  mime: "image/png"
  data: string
  width: number
  height: number
}
