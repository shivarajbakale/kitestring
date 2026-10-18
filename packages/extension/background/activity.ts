import type { ActionResult, ActivityEntry, DialogEvent, Diff } from "@kitestring/protocol"

/** chrome.storage.session key holding the log, oldest first (read by the side panel). */
export const ACTIVITY_KEY = "activity"
export const ACTIVITY_LIMIT = 200
const DIFF_LINES = 20
const PAGE_CHARS = 2000

/** Oldest first. */
let entries: ActivityEntry[] = []
let nextId = 1
let loaded: Promise<void> | null = null
let writes: Promise<void> = Promise.resolve()

export function ready(): Promise<void> {
  loaded ??= (async () => {
    const stored = (await chrome.storage.session.get(ACTIVITY_KEY))[ACTIVITY_KEY] as ActivityEntry[] | undefined
    if (stored?.length) {
      entries = [...stored, ...entries].slice(-ACTIVITY_LIMIT)
      nextId = Math.max(nextId, ...entries.map((e) => e.id + 1))
    }
  })().catch((e: unknown) => {
    loaded = null
    throw e
  })
  return loaded
}

/** A snapshot's ` value="…"` (quoted, with `\"` escapes) or bare ` value=…` annotation. */
const VALUE_RE = / value=(?:"(?:[^"\\]|\\.)*"|[^\s"]\S*)/g

/** What was typed into fields never reaches the stored log (the agent's own result keeps it). */
export const redactValues = (line: string): string => line.replace(VALUE_RE, " value=(redacted)")

const capDiff = (d: Diff): Diff => ({
  added: d.added.slice(0, DIFF_LINES).map(redactValues),
  removed: d.removed.slice(0, DIFF_LINES).map(redactValues),
})

export function record(entry: Omit<ActivityEntry, "id" | "ts">): ActivityEntry {
  const e: ActivityEntry = { ...entry, id: nextId++, ts: Date.now() }
  if (e.diff) e.diff = capDiff(e.diff)
  if (e.page !== undefined) e.page = redactValues(e.page).slice(0, PAGE_CHARS)
  entries.push(e)
  if (entries.length > ACTIVITY_LIMIT) entries.splice(0, entries.length - ACTIVITY_LIMIT)
  const snapshot = entries.slice()
  writes = writes
    .then(() => chrome.storage.session.set({ [ACTIVITY_KEY]: snapshot }))
    .catch((err: unknown) => console.warn("[kite] activity log not persisted", err))
  return e
}

/** Newest first. */
export function list(limit = ACTIVITY_LIMIT): ActivityEntry[] {
  return limit > 0 ? entries.slice(-limit).reverse() : []
}

/** Resolves once every recorded entry has been written to storage. */
export function flush(): Promise<void> {
  return writes
}

/** First line of the CLI's formatResult plus diff counts. */
export function resultSummary(r: ActionResult): string {
  const head = r.status === "done" ? "✓ done" : `✗ ${r.status}${r.detail ? `: ${r.detail}` : ""}`
  return `${head} +${r.diff.added.length}/−${r.diff.removed.length}`
}

/** `✗ CODE: message`, without repeating a `CODE: ` prefix the message already has. */
export function errorSummary(code: string, message: string): string {
  const m = message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message
  return `✗ ${code}: ${m}`
}

/** `! dialog confirm "Really?" dismissed`, as the CLI prints it. */
export function dialogSummary(d: DialogEvent): string {
  return `! dialog ${d.type} "${d.message}" ${d.handled}`
}

/** `✓ paused: lunch`, `✓ paused`, `✓ resumed`: the pause switch flipped over RPC (kite pause / resume). */
export function controlSummary(method: "control.pause" | "control.resume", reason?: string): string {
  if (method === "control.resume") return "✓ resumed"
  return reason ? `✓ paused: ${reason}` : "✓ paused"
}
