import { ErrorCode, READY, type ActionResult, type Diff, type Status, type Target } from "@kitestring/protocol"
import { diffSnapshots, type CheckResult, type FindResult } from "@kitestring/page-agent"
import { callAgent, isRestrictedUrl } from "./agent-bridge"
import { ensureAttached, isNotAttached, onEvent, send } from "./cdp"
import { assertNotPaused } from "./control"
import { watchDialogs, type DialogPolicy, type DialogWatch } from "./dialogs"
import { RestrictedPageError, RpcError } from "./errors"
import * as input from "./input"
import { trackNetwork, type NetworkTracker } from "./network-idle"
import { withTabLock, type TabLock } from "./serial"
import { activeTab, adoptTab, type Session } from "./sessions"

export type Action =
  | { kind: "click" | "fill" | "select"; target: Target; value?: string }
  | { kind: "press"; key: string }
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
async function agentCall<T>(tabId: number, watch: Watch, net: NetworkTracker, p: Progress, method: "snapshot" | "brief" | "readValue", args: unknown[]): Promise<T> {
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
}

async function early(r: Run, status: Status, extra: Partial<ActionResult>): Promise<ActionResult> {
  const page = await safeBrief(r.tabId)
  const res: ActionResult = { ok: false, status, diff: EMPTY, page, ...extra }
  if (r.dialogs.events.length) res.dialogs = [...r.dialogs.events]
  return res
}

/** WAIT → VERIFY → REPORT. */
async function finish(
  r: Run,
  before: string,
  verify: { click?: { handled: boolean }; fill?: { ref: string; text: string } },
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
  for (const id of newTabs) await adoptTab(r.s, id).catch(() => {})

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

  const page = await agentCall<string>(tabId, watch, net, p, "brief", []).catch(() => "")
  p.page = page
  const res: ActionResult = { ok: status === "done", status, diff, page }
  if (detail) res.detail = detail
  if (navigated) res.navigation = { url: urlAfter, title: tab.title ?? "" }
  if (newTabs.length) res.newTabs = newTabs
  if (r.dialogs.events.length) res.dialogs = [...r.dialogs.events]
  return res
}

async function act(r: Run, action: Action): Promise<ActionResult> {
  const { tabId, p } = r
  const guard = () => {
    if (p.expired) throw new Expired()
  }

  if (action.kind === "press" || action.kind === "scroll") {
    const before = await callAgent<string>(tabId, "snapshot", [{ full: false }])
    guard()
    if (action.kind === "press") await input.press(tabId, action.key)
    else {
      const px = action.px ?? (await input.viewport(tabId)).height
      await scrollAndSettle(tabId, action.direction === "up" ? -px : px)
    }
    return finish(r, before, {})
  }

  // FIND (not found → scroll one viewport and retry)
  let found: Extract<FindResult, { kind: "found" }> | undefined
  for (let attempt = 0; !found; attempt++) {
    const f = await callAgent<FindResult>(tabId, "find", [action.target, action.kind])
    guard()
    if (f.kind === "found") found = f
    else if (f.kind === "ambiguous") {
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

  // CHECK (scrolls the element into view)
  const c = await callAgent<CheckResult>(tabId, "check", [found.ref])
  guard()
  if (c.kind === "blocked") return early(r, "blocked", { detail: `covered by ${c.by}`, blockedBy: c.by })
  if (c.kind === "disabled") {
    return early(r, "disabled", {
      detail: c.errors.length ? c.errors.join("; ") : "element is disabled",
      ...(c.errors.length ? { errors: c.errors } : {}),
    })
  }
  if (c.kind === "hidden") return early(r, "not_found", { detail: "element hidden" })

  // Before-snapshot after CHECK's scroll, so scrolling doesn't show up as the action's diff.
  const before = await callAgent<string>(tabId, "snapshot", [{ full: false }])
  guard()

  // ACT
  if (action.kind === "click") {
    const handled = await hasClickHandler(tabId, c.x, c.y)
    guard()
    await input.click(tabId, c.x, c.y)
    return finish(r, before, { click: { handled } })
  }
  if (action.kind === "fill") {
    const text = action.value ?? ""
    await input.click(tabId, c.x, c.y)
    guard()
    await input.selectAll(tabId)
    guard()
    if (text === "") await input.press(tabId, "Backspace")
    else await input.insertText(tabId, text)
    return finish(r, before, { fill: { ref: found.ref, text } })
  }
  const value = action.value ?? ""
  const selected = await callAgent<boolean>(tabId, "setSelect", [found.ref, value])
  if (!selected) return early(r, "error", { detail: `no option ${JSON.stringify(value)} in ${found.line}` })
  return finish(r, before, {})
}

/**
 * Runs `body` with the 15 s cap, holding the tab's lock: actions on one tab run one at a time, and
 * time spent queued counts against the waiter's own cap. On cap, answers `timeout` with whatever is
 * known. Queued waiters re-check the pause switch when their turn comes (pause also rejects them).
 * Exported for unit tests.
 */
export async function capped(tabId: number, body: (p: Progress) => Promise<ActionResult>): Promise<ActionResult> {
  const p: Progress = { diff: EMPTY, expired: false, waiting: true }
  const queue = new AbortController()
  let lock: TabLock | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
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
      setTimeout(() => lock?.release(), EXPIRED_HOLD_MS)
      void (p.page !== undefined ? Promise.resolve(p.page) : safeBrief(tabId, 1_000)).then((page) =>
        resolve({
          ok: false,
          status: "timeout",
          detail: `action did not finish within ${ACTION_CAP_MS} ms`,
          diff: p.diff,
          page,
        }),
      )
    }, ACTION_CAP_MS)
  })
  const run = withTabLock(
    tabId,
    async (l) => {
      lock = l
      p.waiting = false
      if (p.expired) throw new Expired()
      assertNotPaused()
      return body(p)
    },
    { signal: queue.signal },
  ).catch((e: unknown): ActionResult | Promise<ActionResult> => {
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
    return await Promise.race([run, cap])
  } finally {
    clearTimeout(timer)
  }
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
  try {
    const urlBefore = await tabUrl(tabId)
    const net = trackNetwork(tabId)
    try {
      return await fn({ s, tabId, watch, net, p, urlBefore, dialogs })
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
  return capped(tabId, (p) => begin(s, tabId, p, (r) => act(r, action)))
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
  return capped(tabId, async (p) => {
    let navigated = false
    const current = await tabUrl(tabId)
    if (isRestrictedUrl(current) && current !== "about:blank") {
      // The debugger can't attach to the current page (e.g. chrome://newtab): let the browser navigate first.
      const loaded = waitTabComplete(tabId, READY.timeoutMs)
      if (p.expired) throw new Expired()
      await chrome.tabs.update(tabId, { url })
      await loaded
      navigated = true
    }
    return begin(s, tabId, p, async (r) => {
      if (!navigated) {
        if (p.expired) throw new Expired() // the cap already answered: don't navigate after the fact
        const nav = await send<{ loaderId?: string; errorText?: string }>(tabId, "Page.navigate", { url })
        if (nav.errorText) return early(r, "error", { detail: `navigation failed: ${nav.errorText}` })
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
    }, { navigating: () => true })
  })
}
