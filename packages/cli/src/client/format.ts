import type { ActionResult, ActivityEntry, BatchResult, ConsoleEntry, NetworkEntry } from "@kitestring/protocol"

export function formatResult(r: ActionResult): string {
  const lines: string[] = []
  lines.push(r.status === "done" ? "✓ done" : `✗ ${r.status}${r.detail ? `: ${r.detail}` : ""}`)
  for (const a of r.diff?.added ?? []) lines.push(`+ ${a}`)
  for (const d of r.diff?.removed ?? []) lines.push(`- ${d}`)
  if (r.navigation) lines.push(`→ navigated ${r.navigation.url}`)
  for (const id of r.newTabs ?? []) lines.push(`⧉ new tab ${id}`)
  for (const e of r.errors ?? []) lines.push(`! ${e}`)
  for (const d of r.dialogs ?? []) lines.push(`! dialog ${d.type} "${d.message}" ${d.handled}`)
  if (r.uploaded?.length) lines.push(`↑ uploaded ${r.uploaded.join(", ")}`)
  for (const c of r.closedPopups ?? []) lines.push(`⨯ closed popup ${c}`)
  if (r.candidates?.length) {
    lines.push("candidates:")
    for (const c of r.candidates) lines.push(`  ${c.ref} ${c.line}`)
  }
  lines.push(`page: ${r.page}`)
  return lines.join("\n")
}

/**
 * One line per step (1-based; the JSON is 0-based), then the halt and how to resume, then what the
 * batch ran into on the way and the page diff. `StepResult.resolved` is internal and never shown.
 */
export function formatBatch(r: BatchResult): string {
  const lines: string[] = []
  for (const s of r.steps) {
    const what = `${s.action}${s.target ? ` ${s.target}` : ""}`
    if (s.status === "done" || s.status === "no_effect") lines.push(`✓ ${s.i + 1} ${what}`)
    else if (s.status === "skipped") lines.push(`· ${s.i + 1} skipped${s.target ? ` ${s.target}` : ` ${s.action}`}`)
    else lines.push(`✗ ${s.i + 1} ${what}: ${s.detail ?? s.status}`)
  }
  if (r.halted) {
    lines.push(`halted at step ${r.halted.index + 1} (${r.halted.reason})${r.halted.detail ? `: ${r.halted.detail}` : ""}`)
    if (r.next !== undefined) lines.push(`resume with steps from ${r.next + 1}`)
  }
  for (const d of r.dialogs ?? []) lines.push(`! dialog ${d.type} "${d.message}" ${d.handled}`)
  for (const c of r.closedPopups ?? []) lines.push(`⨯ closed popup ${c}`)
  for (const id of r.newTabs ?? []) lines.push(`⧉ new tab ${id}`)
  if (r.navigation) lines.push(`→ navigated ${r.navigation.url}`)
  if (r.candidates?.length) {
    lines.push("candidates:")
    for (const c of r.candidates) lines.push(`  ${c.ref} ${c.line}`)
  }
  for (const a of r.diff?.added ?? []) lines.push(`+ ${a}`)
  for (const d of r.diff?.removed ?? []) lines.push(`- ${d}`)
  lines.push(`page: ${r.page}`)
  return lines.join("\n")
}

const pad2 = (n: number) => String(n).padStart(2, "0")

/** One line per entry, in the order given (the extension sends newest first). */
export function formatActivity(entries: ActivityEntry[]): string {
  if (!entries.length) return "no activity yet"
  return entries
    .map((e) => {
      const d = new Date(e.ts)
      const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
      const what = e.target ? `${e.method} ${e.target}` : e.method
      const dialogs = (e.dialogs ?? []).map((d) => `! dialog ${d.type} "${d.message}" ${d.handled}`).filter((l) => l !== e.summary)
      const summary = [e.summary, ...dialogs].join(" ")
      return `${time}  ${e.session}  tab ${e.tabId ?? "-"}  ${what}  ${summary}  (${e.ms} ms)`
    })
    .join("\n")
}

function where(url: string | undefined, line: number | undefined): string {
  if (!url) return ""
  let name = url
  try {
    const u = new URL(url)
    name = u.pathname.split("/").filter(Boolean).pop() ?? u.host
  } catch {
    // not a URL (e.g. "<anonymous>"): keep as is
  }
  return ` (${name}${line !== undefined ? `:${line}` : ""})`
}

const firstLine = (t: string) => (t.split("\n", 1)[0] ?? "").replace(/^Uncaught /, "")

/** `[error] kaboom (app.js:12)`, one entry per line, oldest first. */
export function formatConsole(entries: ConsoleEntry[]): string {
  if (!entries.length) return "no console entries"
  // One line per entry: an exception's description carries its whole stack (kept in --json).
  return entries.map((e) => `[${e.level}] ${firstLine(e.text)}${where(e.url, e.line)}`).join("\n")
}

/** `GET 500 http://host/status/500 (34 ms)`; `GET ERR url net::ERR_FAILED` when the request failed without a response. */
export function formatNetwork(entries: NetworkEntry[]): string {
  if (!entries.length) return "no network entries"
  return entries
    .map((e) => {
      const status = e.status !== undefined ? String(e.status) : e.failed ? "ERR" : "..."
      const tail = e.ms !== undefined ? ` (${e.ms} ms)` : ""
      return `${e.method} ${status} ${e.url}${e.error ? ` ${e.error}` : ""}${tail}`
    })
    .join("\n")
}
