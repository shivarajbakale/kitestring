import {
  CHOICE_ROLES,
  ErrorCode,
  READY,
  type ActionResult,
  type DialogEvent,
  type Diff,
  type HaltReason,
  type Status,
  type Target,
} from "@kitestring/protocol"
import { diffSnapshots, type CheckResult, type Closer, type FindResult } from "@kitestring/page-agent"
import { callAgent, isRestrictedUrl } from "./agent-bridge"
import { ensureAttached, isNotAttached, onEvent, send } from "./cdp"
import { cacheKey, getHint, hit, ready as cacheReady, remember } from "./cache"
import { assertNotPaused } from "./control"
import { watchDialogs, type DialogPolicy, type DialogWatch } from "./dialogs"
import { RestrictedPageError, RpcError } from "./errors"
import * as input from "./input"
import { trackNetwork, type NetworkTracker } from "./network-idle"
import { setFiles } from "./upload"
import { withTabLock, type TabLock } from "./serial"
import { activeTab, agentActing, type Session } from "./sessions"
import { TAB_CLOSED_ITSELF } from "./tab-closed"

/** `nocache`: the target came from a plan param (plan replay), so the action cache neither looks it up nor keeps it. */
export type Action =
  | { kind: "click" | "fill" | "select"; target: Target; value?: string; nocache?: boolean }
  | { kind: "press"; key: string }
  /** `files` are absolute paths (already vetted by the CLI). */
  | { kind: "upload"; target: Target; files: string[]; nocache?: boolean }
  /** `px` defaults to one viewport height. */
  | { kind: "scroll"; direction: "up" | "down"; px?: number }

/** Hard cap per action, retries included: the CLI has no client-side timeout, so we must always answer. */
const ACTION_CAP_MS = 15_000
/**
 * After the cap has answered, a holder that is still stuck (e.g. a CDP call blocked by a JS alert)
 * gives up its tab lock this much later. Safe: `p.expired` is set, so its guards send no more input.
 */
const EXPIRED_HOLD_MS = 5_000
/** Not-found retries (each scrolls one viewport first). */
const FIND_RETRIES = 3
const EMPTY: Diff = { added: [], removed: [] }

/** What the pipeline has learned so far, for the timeout answer. */
interface Progress {
  diff: Diff
  page?: string
  expired: boolean
  /** Still queued behind another action on the same tab. */
  waiting: boolean
  /** Dialogs handled so far (shared with the run's DialogWatch), for the timeout answer. */
  dialogs?: DialogEvent[]
  /** Popups closed so far (shared with the run), for the timeout answer. */
  closedPopups?: string[]
}

class Expired extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(fallback), Math.max(0, ms))
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

async function tabUrl(tabId: number): Promise<string> {
  const t = await chrome.tabs.get(tabId)
  return t.url || t.pendingUrl || ""
}

/** One-line page summary; "" if the agent can't answer (error page, closed tab). */
function safeBrief(tabId: number, ms = 2_000): Promise<string> {
  return withTimeout(callAgent<string>(tabId, "brief", []), ms, "").catch(() => "")
}

/**
 * Watches the main frame for navigation (Page.frameNavigated / loading state) and the tab for
 * popups it opens (chrome.tabs.onCreated with openerTabId).
 */
class Watch {
  /** Bumped whenever the main frame starts loading or commits a navigation. */
  seq = 0
  loading = false
  navigated = false
  readonly newTabs: number[] = []
  private waiters: (() => void)[] = []
  private offCdp: () => void
  private onCreated = (t: chrome.tabs.Tab) => {
    if (t.openerTabId === this.tabId && t.id !== undefined) this.newTabs.push(t.id)
  }

  private constructor(
    private tabId: number,
    private mainFrameId: string,
  ) {
    this.offCdp = onEvent(tabId, ({ method, params }) => {
      const frameId = params.frameId as string | undefined
      switch (method) {
        case "Page.frameStartedLoading":
          if (frameId === this.mainFrameId) {
            this.loading = true
            this.seq++
          }
          break
        case "Page.frameNavigated": {
          const frame = params.frame as { id: string; parentId?: string }
          if (!frame.parentId) {
            this.mainFrameId = frame.id
            this.navigated = true
            this.seq++
          }
          break
        }
        case "Page.navigatedWithinDocument":
          if (frameId === this.mainFrameId) this.navigated = true
          break
        case "Page.loadEventFired":
          this.loaded()
          break
        case "Page.frameStoppedLoading":
          if (frameId === this.mainFrameId) this.loaded()
          break
      }
    })
    chrome.tabs.onCreated.addListener(this.onCreated)
  }

  static async start(tabId: number): Promise<Watch> {
    const tree = await send<{ frameTree: { frame: { id: string } } }>(tabId, "Page.getFrameTree")
    return new Watch(tabId, tree.frameTree.frame.id)
  }

  /** Expect a navigation (Page.navigate answered with a loader) even if its first event is still in flight. */
  expectLoad(): void {
    this.loading = true
    this.seq++
  }

  private loaded(): void {
    this.loading = false
    for (const w of this.waiters.splice(0)) w()
  }

  /** Resolves true when the main frame finished loading, false after `ms`. */
  waitLoaded(ms: number): Promise<boolean> {
    if (!this.loading) return Promise.resolve(true)
    return withTimeout(
      new Promise<boolean>((resolve) => this.waiters.push(() => resolve(true))),
      ms,
      false,
    )
  }

  stop(): void {
    this.offCdp()
    chrome.tabs.onCreated.removeListener(this.onCreated)
    this.loaded()
  }
}

/**
 * WAIT: network idle AND page agent quiet, capped at READY.timeoutMs. A navigation (link click,
 * form submit, Page.navigate) kills the content script: wait for the load event, then ask again —
 * callAgent re-injects the agent into the new document if it isn't there yet.
 */
async function settle(tabId: number, watch: Watch, net: NetworkTracker, p: Progress): Promise<boolean> {
  const deadline = Date.now() + READY.timeoutMs
  for (;;) {
    if (p.expired) throw new Expired()
    const rem = deadline - Date.now()
    if (rem <= 0) return false
    if (watch.loading) {
      if (!(await watch.waitLoaded(rem))) return false
      continue
    }
    const seq = watch.seq
    try {
      const [idle, q] = await Promise.all([
        net.waitIdle(READY.quietMs, rem),
        withTimeout(callAgent<{ quiet: boolean }>(tabId, "waitQuiet", []), rem, { quiet: false }),
      ])
      if (watch.seq !== seq || watch.loading) continue // navigated meanwhile: settle the new page
      return idle && q.quiet
    } catch (e) {
      if (e instanceof RestrictedPageError) throw e
      // The agent died mid-call. If that was a navigation, settle the new document.
      await sleep(100)
      if (watch.seq !== seq || watch.loading) continue
      throw e
    }
  }
}

/** Calls the page agent, riding out a navigation that starts during the call. */
async function agentCall<T>(tabId: number, watch: Watch, net: NetworkTracker, p: Progress, method: "snapshot" | "brief" | "readValue" | "fileNames", args: unknown[]): Promise<T> {
  for (let i = 0; ; i++) {
    const seq = watch.seq
    try {
      return await callAgent<T>(tabId, method, args)
    } catch (e) {
      if (e instanceof RestrictedPageError || i >= 2) throw e
      await sleep(100)
      if (watch.seq === seq && !watch.loading) throw e
      await settle(tabId, watch, net, p)
    }
  }
}

/**
 * Does anything on the page listen for the click at (x, y)? Listeners that only change JS state
 * leave no trace in the snapshot, so "no diff" alone cannot tell them from a dead control.
 */
async function hasClickHandler(tabId: number, x: number, y: number): Promise<boolean> {
  const CLICK = new Set(["click", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend"])
  const objectGroup = "kite-click-handler"
  try {
    // [element, ...ancestors (through shadow hosts), window], plus the enclosing form (for "submit").
    const chain = await send<{ result: { objectId?: string } }>(tabId, "Runtime.evaluate", {
      objectGroup,
      expression: `(() => {
        const el = document.elementFromPoint(${x}, ${y});
        const nodes = [];
        for (let n = el; n; n = n.parentNode || n.host || null) nodes.push(n);
        nodes.push(window);
        const form = el && el.closest ? el.closest("form") : null;
        return { nodes, form };
      })()`,
    })
    const id = chain.result.objectId
    if (!id) return true
    const props = async (objectId: string) =>
      (await send<{ result: { name: string; value?: { objectId?: string } }[] }>(tabId, "Runtime.getProperties", {
        objectId,
        ownProperties: true,
      })).result
    const top = await props(id)
    const listeners = async (objectId: string) =>
      (await send<{ listeners: { type: string }[] }>(tabId, "DOMDebugger.getEventListeners", { objectId })).listeners
    const nodesId = top.find((p) => p.name === "nodes")?.value?.objectId
    if (nodesId) {
      for (const p of await props(nodesId)) {
        const oid = p.value?.objectId
        if (!/^\d+$/.test(p.name) || !oid) continue
        if ((await listeners(oid)).some((l) => CLICK.has(l.type))) return true
      }
    }
    const formId = top.find((p) => p.name === "form")?.value?.objectId
    return !!formId && (await listeners(formId)).some((l) => l.type === "submit")
  } catch {
    return true // unknown: don't claim no_effect
  } finally {
    void send(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {})
  }
}

/**
 * Mouse-wheel scroll, then wait until the page has actually scrolled and stopped (wheel scrolling is
 * asynchronous and may be animated). Pages that load on "scroll" start their work only then, so the
 * following quiet check sees it.
 */
async function scrollAndSettle(tabId: number, dy: number): Promise<void> {
  const pos = async () =>
    (await send<{ result: { value?: [number, number] } }>(tabId, "Runtime.evaluate", {
      expression: "[scrollY, (document.scrollingElement || document.documentElement).scrollHeight - innerHeight]",
      returnByValue: true,
    })).result.value ?? [0, 0]
  const [y0, max] = await pos()
  await input.wheel(tabId, dy)
  const canMove = dy > 0 ? y0 < max - 1 : y0 > 0
  const start = Date.now()
  let last = y0
  let lastChange = start
  let moved = false
  while (Date.now() - start < 1_000) {
    await sleep(50)
    const [y] = await pos()
    if (y !== last) {
      last = y
      lastChange = Date.now()
      moved = true
    }
    if ((moved || !canMove) && Date.now() - lastChange >= 100) return
  }
}

function targetText(t: Target): string {
  return "ref" in t ? t.ref : `"${t.text}"`
}

interface Run {
  s: Session
  tabId: number
  watch: Watch
  net: NetworkTracker
  p: Progress
  urlBefore: string
  dialogs: DialogWatch
  /** Cookie walls / newsletter modals closed on the way: reported with every outcome. */
  closedPopups: string[]
}

/** The element FIND resolved, as `beforeAct` sees it. */
export interface Found {
  ref: string
  line: string
  role: string
  name: string
}

/** Batch hooks into one action (single actions pass none). */
interface Hooks {
  /** After CHECK passed (for a press: on what it would submit), before any input: a non-null reason refuses the action. */
  beforeAct?: (found: Found) => HaltReason | null
  /** Set when beforeAct refused. */
  refused?: HaltReason
  /** Set once the action's own input went out (a popup closer's click does not count). */
  acted?: boolean
  /** What FIND resolved (text targets for stored plans; refs are never stored). */
  resolved?: { role: string; name: string; within?: string }
  /** Set when the element FIND matched is where the action cache last found it (the full search still ran). */
  cached?: boolean
  /** Set when FIND resolved a password / card / one-time-code field. */
  secret?: boolean
  /** A select's chosen option text. */
  chosen?: string
}

async function early(r: Run, status: Status, extra: Partial<ActionResult>): Promise<ActionResult> {
  const page = await safeBrief(r.tabId)
  const res: ActionResult = { ok: false, status, diff: EMPTY, page, ...extra }
  if (r.dialogs.events.length) res.dialogs = [...r.dialogs.events]
  if (r.closedPopups.length) res.closedPopups = [...r.closedPopups]
  return res
}

/**
 * WAIT → VERIFY → REPORT. An action that closes its own tab (an OAuth "Allow", a "Done" button) is a
 * success, not a "No tab with id" failure.
 */
async function finish(
  r: Run,
  before: string,
  verify: { click?: { handled: boolean }; fill?: { ref: string; text: string }; upload?: { ref: string; names: string[] } },
): Promise<ActionResult> {
  try {
    return await finishOpen(r, before, verify)
  } catch (e) {
    // Closing is not instant: a "target closed" or detach error may come before the tab is gone.
    if (!(await tabGone(r.tabId, e instanceof Expired ? 1 : 6))) throw e
    const res: ActionResult = { ok: true, status: "done", diff: EMPTY, page: "", detail: TAB_CLOSED_ITSELF }
    if (r.watch.newTabs.length) res.newTabs = [...r.watch.newTabs]
    if (r.dialogs.events.length) res.dialogs = [...r.dialogs.events]
    if (r.closedPopups.length) res.closedPopups = [...r.closedPopups]
    return res
  }
}

async function tabGone(tabId: number, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await chrome.tabs.get(tabId).then(() => false, () => true)) return true
    if (i + 1 < tries) await new Promise((res) => setTimeout(res, 50))
  }
  return false
}

async function finishOpen(
  r: Run,
  before: string,
  verify: { click?: { handled: boolean }; fill?: { ref: string; text: string }; upload?: { ref: string; names: string[] } },
): Promise<ActionResult> {
  const { tabId, watch, net, p } = r
  const ready = await settle(tabId, watch, net, p)
  if (p.expired) throw new Expired()

  const after = await agentCall<string>(tabId, watch, net, p, "snapshot", [{ full: false }])
  const diff = diffSnapshots(before, after)
  p.diff = diff

  const tab = await chrome.tabs.get(tabId)
  const urlAfter = tab.url || tab.pendingUrl || ""
  const navigated = watch.navigated || urlAfter !== r.urlBefore
  const newTabs = [...watch.newTabs]

  let status: Status = ready ? "done" : "timeout"
  let detail: string | undefined = ready ? undefined : `page not ready after ${READY.timeoutMs} ms`
  if (status === "done" && verify.click) {
    const empty = diff.added.length === 0 && diff.removed.length === 0
    if (empty && !navigated && newTabs.length === 0 && !verify.click.handled) {
      status = "no_effect"
      detail = "nothing changed on the page"
    }
  }
  if (status === "done" && verify.fill) {
    const value = await agentCall<string | null>(tabId, watch, net, p, "readValue", [verify.fill.ref])
    if (value !== verify.fill.text) {
      status = "error"
      detail = `value mismatch: expected ${JSON.stringify(verify.fill.text)}, got ${JSON.stringify(value)}`
    }
  }

  if (status === "done" && verify.upload) {
    const names = await agentCall<string[] | null>(tabId, watch, net, p, "fileNames", [verify.upload.ref])
    if (JSON.stringify(names) !== JSON.stringify(verify.upload.names)) {
      status = "error"
      detail = `file input holds ${JSON.stringify(names)}, expected ${JSON.stringify(verify.upload.names)}`
    }
  }

  const page = await agentCall<string>(tabId, watch, net, p, "brief", []).catch(() => "")
  p.page = page
  const res: ActionResult = { ok: status === "done", status, diff, page }
  if (detail) res.detail = detail
  if (navigated) res.navigation = { url: urlAfter, title: tab.title ?? "" }
  if (newTabs.length) res.newTabs = newTabs
  if (r.dialogs.events.length) res.dialogs = [...r.dialogs.events]
  if (r.closedPopups.length) res.closedPopups = [...r.closedPopups]
  return res
}

async function act(r: Run, action: Action, hooks: Hooks = {}): Promise<ActionResult> {
  const { tabId, p } = r
  const guard = () => {
    if (p.expired) throw new Expired()
  }

  if (action.kind === "press" || action.kind === "scroll") {
    if (action.kind === "press" && hooks.beforeAct) {
      // The batch checks a press of Enter / Space against what it would activate: the focused button or link, or the
      // focused field's form's default button.
      const submit = await callAgent<Found | null>(tabId, "pressTarget", [action.key])
      guard()
      const refused = submit && hooks.beforeAct(submit)
      if (refused) {
        hooks.refused = refused
        return early(r, "error", {
          detail: `refused: ${action.key} would activate ${JSON.stringify(submit.name)}, which looks ${refused === "risky" ? "risky (it may pay, send or delete something)" : refused}; click it on its own if intended`,
        })
      }
    }
    const before = await callAgent<string>(tabId, "snapshot", [{ full: false }])
    guard()
    hooks.acted = true
    if (action.kind === "press") await input.press(tabId, action.key)
    else {
      const px = action.px ?? (await input.viewport(tabId)).height
      await scrollAndSettle(tabId, action.direction === "up" ? -px : px)
    }
    return finish(r, before, {})
  }

  // FIND (not found → scroll one viewport and retry). A cached locator is only a hint the page agent verifies.
  const key = action.nocache ? "" : cacheKey(r.urlBefore, action.target)
  if (key) await cacheReady().catch(() => {})
  const hint = key ? getHint(key) : undefined
  let found: Extract<FindResult, { kind: "found" }> | undefined
  for (let attempt = 0; !found; attempt++) {
    // An upload target is something to click (styled button, drop zone) unless it resolves to an input.
    const f = await callAgent<FindResult>(tabId, "find", [
      action.target,
      action.kind === "upload" ? "click" : action.kind,
      ...(hint ? [hint] : []),
    ])
    guard()
    if (f.kind === "found") {
      found = f
      if (f.hinted) {
        hooks.cached = true
        hit(key)
      }
      // Never cache a secret field (password, card, one-time code) or a picked choice (its name is data, like a
      // value); an upload caches the locator only.
      else if (key && f.locator && !f.secret && !CHOICE_ROLES.has(f.role)) {
        remember(key, f.locator)
        // A stored plan replays this element by its resolved name/role/scope: let that find start from the hint too.
        const asStored = cacheKey(r.urlBefore, { text: f.name, role: f.role, ...(f.within ? { within: f.within } : {}) })
        if (asStored && asStored !== key) remember(asStored, f.locator)
      }
      hooks.resolved = { role: f.role, name: f.name, ...(f.within ? { within: f.within } : {}) }
      if (f.secret) hooks.secret = true
    } else if (f.kind === "ambiguous") {
      return early(r, "ambiguous", {
        detail: `${f.candidates.length} elements match ${targetText(action.target)}`,
        candidates: f.candidates,
      })
    } else if (attempt >= FIND_RETRIES || "ref" in action.target) {
      return early(r, "not_found", { detail: `no element matches ${targetText(action.target)}` })
    } else {
      await scrollAndSettle(tabId, (await input.viewport(tabId)).height)
      await callAgent(tabId, "waitQuiet", [])
      guard()
    }
  }

  // UPLOAD with a file input behind the target: set the files directly, no click or dialog needed.
  if (action.kind === "upload") {
    const fileInput = await callAgent<{ ref: string; multiple: boolean } | null>(tabId, "fileInputFor", [found.ref])
    guard()
    if (fileInput) {
      const before = await callAgent<string>(tabId, "snapshot", [{ full: false }])
      guard()
      hooks.acted = true
      await setFiles(tabId, fileInput, action.files)
      return withUploaded(await finish(r, before, { upload: { ref: fileInput.ref, names: action.files.map(baseName) } }), action.files)
    }
  }

  // CHECK (scrolls the element into view)
  let c = await callAgent<CheckResult>(tabId, "check", [found.ref])
  guard()
  const { closedPopups } = r
  if (c.kind === "blocked") {
    // A cookie wall or newsletter modal in the way: close it once, then check again.
    const closer = await callAgent<Closer | null>(tabId, "closerFor", [found.ref])
    guard()
    const cc = closer && (await callAgent<CheckResult>(tabId, "check", [closer.ref]))
    guard()
    if (closer && cc && cc.kind === "ok") {
      await input.click(tabId, cc.x, cc.y)
      closedPopups.push(`${closer.kind} "${/^\S+ "(.*)" \[@/.exec(closer.line)?.[1] ?? closer.line}"`)
      await settle(tabId, r.watch, r.net, p)
      guard()
      c = await callAgent<CheckResult>(tabId, "check", [found.ref])
      guard()
    }
  }
  if (c.kind === "blocked") {
    return early(r, "blocked", { detail: `covered by ${c.by}`, blockedBy: c.by })
  }
  if (c.kind === "disabled") {
    return early(r, "disabled", {
      detail: c.errors.length ? c.errors.join("; ") : "element is disabled",
      ...(c.errors.length ? { errors: c.errors } : {}),
    })
  }
  if (c.kind === "hidden") return early(r, "not_found", { detail: "element hidden" })

  const refused = hooks.beforeAct?.({ ref: found.ref, line: found.line, role: found.role, name: found.name })
  if (refused) {
    hooks.refused = refused
    return early(r, "error", {
      detail: `refused: "${found.name}" looks ${refused === "risky" ? "risky (it may pay, send or delete something)" : refused}; run it on its own if intended`,
    })
  }

  // Before-snapshot after CHECK's scroll, so scrolling doesn't show up as the action's diff.
  const before = await callAgent<string>(tabId, "snapshot", [{ full: false }])
  guard()

  // ACT
  if (action.kind === "upload") {
    // No input is associated with the target: click it and answer the file chooser the page opens.
    hooks.acted = true
    const held = await setFiles(tabId, null, action.files, { x: c.x, y: c.y })
    guard()
    const names = action.files.map(baseName)
    const res = withUploaded(await finish(r, before, {}), action.files)
    if (res.status === "done" && JSON.stringify(held) !== JSON.stringify(names)) {
      const { uploaded: _unverified, ...rest } = res
      return { ...rest, ok: false, status: "error", detail: `file input holds ${JSON.stringify(held)}, expected ${JSON.stringify(names)}` }
    }
    return res
  }
  if (action.kind === "click") {
    const handled = await hasClickHandler(tabId, c.x, c.y)
    guard()
    hooks.acted = true
    await input.click(tabId, c.x, c.y)
    return finish(r, before, { click: { handled } })
  }
  if (action.kind === "fill") {
    const text = action.value ?? ""
    hooks.acted = true
    await input.click(tabId, c.x, c.y)
    guard()
    await input.selectAll(tabId)
    guard()
    if (text === "") await input.press(tabId, "Backspace")
    else await input.insertText(tabId, text)
    return finish(r, before, { fill: { ref: found.ref, text } })
  }
  const value = action.value ?? ""
  const chosen = await callAgent<string | null>(tabId, "setSelect", [found.ref, value])
  if (chosen === null) return early(r, "error", { detail: `no option ${JSON.stringify(value)} in ${found.line}` })
  hooks.acted = true
  hooks.chosen = chosen
  return finish(r, before, {})
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Names only: the result and the activity log never carry directories. */
function withUploaded(res: ActionResult, files: string[]): ActionResult {
  return res.status === "done" ? { ...res, uploaded: files.map(baseName) } : res
}

interface CapOpts {
  /** Default ACTION_CAP_MS. */
  capMs?: number
  /** The caller (a batch) already holds the tab's lock: don't queue for it, keep the cap. */
  holdsLock?: boolean
}

interface Capped {
  res: ActionResult
  /** The cap answered (the body may still be unwinding). */
  expired: boolean
  /** Resolves when the body has ended, or EXPIRED_HOLD_MS after the cap if it is stuck. */
  tail: Promise<void>
}

async function cappedRun(tabId: number, body: (p: Progress) => Promise<ActionResult>, opts: CapOpts = {}): Promise<Capped> {
  const capMs = opts.capMs ?? ACTION_CAP_MS
  const p: Progress = { diff: EMPTY, expired: false, waiting: !opts.holdsLock }
  const queue = new AbortController()
  let lock: TabLock | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stuck: Promise<void> = Promise.resolve()
  const cap = new Promise<ActionResult>((resolve) => {
    timer = setTimeout(() => {
      p.expired = true
      if (p.waiting) {
        queue.abort(new Expired())
        void safeBrief(tabId, 1_000).then((page) =>
          resolve({ ok: false, status: "timeout", detail: "waited for another action on this tab", diff: EMPTY, page }),
        )
        return
      }
      stuck = sleep(EXPIRED_HOLD_MS).then(() => {})
      if (!opts.holdsLock) void stuck.then(() => lock?.release())
      void (p.page !== undefined ? Promise.resolve(p.page) : safeBrief(tabId, 1_000)).then((page) =>
        resolve({
          ok: false,
          status: "timeout",
          detail: `action did not finish within ${capMs} ms`,
          diff: p.diff,
          page,
          ...(p.dialogs?.length ? { dialogs: [...p.dialogs] } : {}),
          ...(p.closedPopups?.length ? { closedPopups: [...p.closedPopups] } : {}),
        }),
      )
    }, Math.max(0, capMs))
  })
  const guarded = async (): Promise<ActionResult> => {
    p.waiting = false
    if (p.expired) throw new Expired()
    assertNotPaused()
    return body(p)
  }
  const ran = opts.holdsLock
    ? guarded()
    : withTabLock(
        tabId,
        async (l) => {
          lock = l
          return guarded()
        },
        { signal: queue.signal },
      )
  const settled = ran.then(
    () => {},
    () => {},
  )
  const run = ran.catch((e: unknown): ActionResult | Promise<ActionResult> => {
    // The cap fired: its answer (built asynchronously) is the result, not the abandoned body's error.
    if (e instanceof Expired) return cap
    // R14: a browser-side TIMEOUT inside the pipeline (e.g. the page never became scriptable) is an
    // action outcome, not an RPC failure.
    if (e instanceof RpcError && e.code === ErrorCode.TIMEOUT) {
      return { ok: false, status: "timeout", detail: e.message, diff: { added: [], removed: [] }, page: "" }
    }
    throw e
  })
  try {
    const res = await Promise.race([run, cap])
    return { res, expired: p.expired, tail: p.expired ? Promise.race([settled, stuck]) : settled }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs `body` with the cap (default 15 s), holding the tab's lock unless the caller does: actions on
 * one tab run one at a time, and time spent queued counts against the waiter's own cap. On cap,
 * answers `timeout` with whatever is known. Queued waiters re-check the pause switch when their turn
 * comes (pause also rejects them). Exported for unit tests.
 */
export async function capped(tabId: number, body: (p: Progress) => Promise<ActionResult>, opts: CapOpts = {}): Promise<ActionResult> {
  return (await cappedRun(tabId, body, opts)).res
}

interface DialogOpts {
  policy?: DialogPolicy
  navigating?: () => boolean
}

async function begin(
  s: Session,
  tabId: number,
  p: Progress,
  fn: (r: Run) => Promise<ActionResult>,
  dialogOpts: DialogOpts = {},
): Promise<ActionResult> {
  const ended = agentActing(tabId)
  try {
    return await beginActing(s, tabId, p, fn, dialogOpts)
  } finally {
    ended()
  }
}

async function beginActing(
  s: Session,
  tabId: number,
  p: Progress,
  fn: (r: Run) => Promise<ActionResult>,
  dialogOpts: DialogOpts,
): Promise<ActionResult> {
  let watch: Watch
  try {
    await ensureAttached(tabId)
    watch = await Watch.start(tabId)
  } catch (e) {
    if (!isNotAttached(e)) throw e
    await ensureAttached(tabId) // the session went away since the last action: attach again
    watch = await Watch.start(tabId)
  }
  const dialogs = watchDialogs(tabId, dialogOpts)
  p.dialogs = dialogs.events
  const closedPopups: string[] = []
  p.closedPopups = closedPopups
  try {
    const urlBefore = await tabUrl(tabId)
    const net = trackNetwork(tabId)
    try {
      return await fn({ s, tabId, watch, net, p, urlBefore, dialogs, closedPopups })
    } finally {
      net.stop()
    }
  } finally {
    dialogs.stop()
    watch.stop()
  }
}

/** FIND → CHECK → ACT → WAIT → VERIFY → REPORT on the session's active tab. */
export function runAction(s: Session, action: Action): Promise<ActionResult> {
  if (action.kind === "press") input.keyDef(action.key) // BAD_REQUEST before touching the page
  const tabId = activeTab(s)
  return capped(tabId, (p) =>
    begin(s, tabId, p, async (r) => {
      const hooks: Hooks = {}
      const res = await act(r, action, hooks)
      return hooks.cached ? { ...res, cached: true } : res
    }),
  )
}

function waitTabComplete(tabId: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve()
    }
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") done()
    }
    const timer = setTimeout(done, ms)
    chrome.tabs.onUpdated.addListener(onUpdated)
  })
}

/** Navigates the session's active tab and waits until the new page is ready. */
export function goto(s: Session, url: string): Promise<ActionResult> {
  const tabId = activeTab(s)
  if (isRestrictedUrl(url)) throw new RestrictedPageError(url)
  return capped(tabId, (p) => navigate(s, tabId, url, p))
}

async function navigate(
  s: Session,
  tabId: number,
  url: string,
  p: Progress,
  policy?: DialogPolicy,
  hooks: Hooks = {},
): Promise<ActionResult> {
  let navigated = false
  const current = await tabUrl(tabId)
  if (isRestrictedUrl(current) && current !== "about:blank") {
    // The debugger can't attach to the current page (e.g. chrome://newtab): let the browser navigate first.
    const loaded = waitTabComplete(tabId, READY.timeoutMs)
    if (p.expired) throw new Expired()
    hooks.acted = true
    await chrome.tabs.update(tabId, { url })
    await loaded
    navigated = true
  }
  return begin(s, tabId, p, async (r) => {
    if (!navigated) {
      if (p.expired) throw new Expired() // the cap already answered: don't navigate after the fact
      const nav = await send<{ loaderId?: string; errorText?: string }>(tabId, "Page.navigate", { url })
      if (nav.errorText) return early(r, "error", { detail: `navigation failed: ${nav.errorText}` })
      hooks.acted = true
      if (nav.loaderId) r.watch.expectLoad()
    }
    const ready = await settle(tabId, r.watch, r.net, p)
    const tab = await chrome.tabs.get(tabId)
    const page = await safeBrief(tabId)
    const res: ActionResult = {
      ok: ready,
      status: ready ? "done" : "timeout",
      diff: EMPTY,
      navigation: { url: tab.url || url, title: tab.title ?? "" },
      page,
    }
    if (!ready) res.detail = `page not ready after ${READY.timeoutMs} ms`
    if (r.dialogs.events.length) res.dialogs = [...r.dialogs.events]
    return res
  }, { navigating: () => true, ...(policy ? { policy } : {}) })
}

export type StepAction = Action | { kind: "goto"; url: string }

export interface StepOutcome extends ActionResult {
  resolved?: { role: string; name: string; within?: string }
  /** The resolved field was secret (password / cc-* / one-time-code). */
  secret?: true
  /** A select's chosen option text (stored plans treat it as a value). */
  chosen?: string
  /** `risky` (beforeAct refused) or `time` (the step's cap expired). */
  halt?: HaltReason
  /** The step's own input went out (or the navigation started): resending it would repeat it. */
  acted: boolean
}

/**
 * One batch step on `tabId`, whose lock the caller (the batch) already holds. `capMs` bounds it
 * like ACTION_CAP_MS bounds a single action; `linger` gets a promise that resolves when the step
 * has truly ended (after an expiry, at most EXPIRED_HOLD_MS later), so the batch can keep the lock
 * until then.
 */
export async function runStep(
  s: Session,
  tabId: number,
  action: StepAction,
  opts: {
    capMs: number
    dialog?: DialogPolicy
    beforeAct?: (found: Found) => HaltReason | null
    linger?: (tail: Promise<void>) => void
  },
): Promise<StepOutcome> {
  if (action.kind === "press") input.keyDef(action.key) // BAD_REQUEST before touching the page
  if (action.kind === "goto" && isRestrictedUrl(action.url)) throw new RestrictedPageError(action.url)
  const hooks: Hooks = opts.beforeAct ? { beforeAct: opts.beforeAct } : {}
  let ran: Capped
  try {
    ran = await cappedRun(
      tabId,
      (p) =>
        action.kind === "goto"
          ? navigate(s, tabId, action.url, p, opts.dialog, hooks)
          : begin(s, tabId, p, (r) => act(r, action, hooks), opts.dialog ? { policy: opts.dialog } : {}),
      { capMs: opts.capMs, holdsLock: true },
    )
  } catch (e) {
    // Before any input the caller classifies the error (restricted, paused, ...) and resends the step.
    if (!hooks.acted) throw e
    // After it, resending would repeat the input: an error outcome that acted.
    const detail = e instanceof Error ? e.message : String(e)
    return { ok: false, status: "error", detail, diff: EMPTY, page: await safeBrief(tabId), halt: "error", acted: true }
  }
  const { res, expired, tail } = ran
  opts.linger?.(tail)
  const out: StepOutcome = { ...res, acted: !!hooks.acted }
  if (hooks.resolved) out.resolved = hooks.resolved
  if (hooks.cached) out.cached = true
  if (hooks.secret) out.secret = true
  if (hooks.chosen !== undefined) out.chosen = hooks.chosen
  if (expired) out.halt = "time"
  else if (hooks.refused) out.halt = hooks.refused
  return out
}
