import type { ActionResult } from "@bx/protocol"

export function formatResult(r: ActionResult): string {
  const lines: string[] = []
  lines.push(r.status === "done" ? "✓ done" : `✗ ${r.status}${r.detail ? `: ${r.detail}` : ""}`)
  for (const a of r.diff?.added ?? []) lines.push(`+ ${a}`)
  for (const d of r.diff?.removed ?? []) lines.push(`- ${d}`)
  if (r.navigation) lines.push(`→ navigated ${r.navigation.url}`)
  if (r.candidates?.length) {
    lines.push("candidates:")
    for (const c of r.candidates) lines.push(`  ${c.ref} ${c.line}`)
  }
  lines.push(`page: ${r.page}`)
  return lines.join("\n")
}
