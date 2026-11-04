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

/** Where FIND last found an element: a hint for the next run, never trusted without a role and name check. */
export interface Locator {
  ref: string
  role: string
  name: string
  /** Names of the enclosing landmarks, outermost first. */
  landmarkPath: string[]
  cssPath: string
  /** Index among the page's elements with the same role, name and landmark path. */
  nth: number
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
  /** Cookie walls / newsletter modals closed to reach the target, each `<kind> "<button name>"`. */
  closedPopups?: string[]
  /** act.upload: base names of the files put into the input (never directories). */
  uploaded?: string[]
  /** The element FIND matched is where the action cache last found it (the full search still ran). */
  cached?: boolean
  /**
   * `page`: the tab was hidden (Chrome delivers no real input there), so the click or typing went as the page's own DOM
   * events. Most sites take them; one that only accepts real input may not have reacted.
   */
  via?: "page"
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
  /** JS dialogs answered during the call (or, for method "dialog", the one answered between calls). */
  dialogs?: DialogEvent[]
}

export interface ControlState {
  paused: boolean
  reason?: string
  /** Epoch ms of the last pause/resume. */
  since?: number
}

/** A request for the person at the browser, as kept in chrome.storage.session `kite.handoff`. */
export interface Handoff {
  session: string
  /** The session's active tab when the agent asked; null when it had none. */
  tabId: number | null
  reason: string
  /** Epoch ms when the agent first asked. */
  since: number
  /** Set when the person answered before the agent's next human.ask picked it up. */
  outcome?: "done" | "declined"
}

/** human.ask: `waiting` until the person clicks Done or Can't do it. */
export interface HandoffResult {
  status: "done" | "declined" | "waiting"
  reason: string
  since: number
}

/** A table or repeated list of a page, as rows (`page.extract`). */
export interface ExtractCandidate {
  /** Ranked position, for `pick`. */
  index: number
  /** Stable across pages of the same site: pass it back as `key`. */
  key: string
  /** What it is, for a person: `table "Orders" (2 rows: Order, Date, Total)`, `list of 20 div.card`. */
  source: string
  count: number
}

export interface ExtractResult {
  key: string
  source: string
  columns: string[]
  rows: Record<string, string>[]
  /** Rows on the page before `max`. */
  total: number
  /** The other candidates, best first (at most 5). */
  others: ExtractCandidate[]
  /**
   * When the rows sit in a box that scrolls on its own (a results panel beside a map), a point over that box in
   * viewport CSS pixels: a wheel there scrolls the list, where one at the viewport's centre would scroll something else.
   */
  scrollAt?: { x: number; y: number }
}

/** One repeated list on a page, as `page.probe` describes it. */
export interface ProbeList {
  index: number
  key: string
  source: string
  count: number
  /** CSS selector matching the items (one per row), when a short one was found: `collect({items})`. */
  selector?: string
  columns: string[]
  /** Per column, a selector relative to an item: `css` (its text), `css@attr`, or `.` (the item's own text). */
  fields?: Record<string, string>
  sample: Record<string, string>[]
  /** The column holding each item's link (a detail page). */
  link?: string
  /** The first item's markup, trimmed (no scripts, short text). */
  itemHtml?: string
  scrollAt?: { x: number; y: number }
}

/** What a page's data looks like: its lists, how it shows more, and values to look for in its JSON. */
export interface ProbeResult {
  url: string
  title: string
  lists: ProbeList[]
  /** A next button's text, or scrolling of the page or of the list's own panel; empty when neither. */
  more: { next?: string; scroll?: "page" | "panel" }
  /** Visible values from the best list (names, titles): where they also appear in JSON, the data is there. */
  needles: string[]
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
  /** The response's MIME type. */
  mime?: string
  /** Kept response bodies are numbered: `page.network {body: id}` returns one whole. */
  bodyId?: number
  /** Size in characters of the kept body. */
  bodyChars?: number
  /** The kept body (cut to `body_max`), when asked for with `bodies`. */
  body?: string
}

export interface ScreenshotResult {
  mime: "image/png"
  data: string
  width: number
  height: number
}
