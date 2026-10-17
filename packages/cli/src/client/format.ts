import type { ActionResult, ActivityEntry } from "@kitestring/protocol"

export function formatResult(r: ActionResult): string {
  const lines: string[] = []
  lines.push(r.status === "done" ? "✓ done" : `✗ ${r.status}${r.detail ? `: ${r.detail}` : ""}`)
  for (const a of r.diff?.added ?? []) lines.push(`+ ${a}`)
  for (const d of r.diff?.removed ?? []) lines.push(`- ${d}`)
  if (r.navigation) lines.push(`→ navigated ${r.navigation.url}`)
  for (const id of r.newTabs ?? []) lines.push(`⧉ new tab ${id}`)
  for (const e of r.errors ?? []) lines.push(`! ${e}`)
  if (r.candidates?.length) {
    lines.push("candidates:")
    for (const c of r.candidates) lines.push(`  ${c.ref} ${c.line}`)
  }
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
      return `${time}  ${e.session}  tab ${e.tabId ?? "-"}  ${what}  ${e.summary}  (${e.ms} ms)`
    })
    .join("\n")
}
