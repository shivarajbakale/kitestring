import {
  BATCH_DIFF_MAX_LINES,
  BATCH_RESULT_MAX_BYTES,
  registrableDomain,
  type BatchParams,
  type BatchResult,
  type DialogEvent,
  type Diff,
  type HaltReason,
  type Status,
  type Step,
} from "@kitestring/protocol"

/** The halt a pipeline status causes; `done` and `no_effect` never halt. */
export function haltFor(status: Status): HaltReason | null {
  return status === "done" || status === "no_effect" ? null : status
}

/** A dismissed confirm/prompt/beforeunload step `i` had no `dialog` policy for. */
export function dialogHalt(dialogs: DialogEvent[] | undefined, step: Step, i: number): string | null {
  if (step.dialog) return null
  const d = dialogs?.find((e) => e.type !== "alert" && e.handled === "dismissed")
  return d ? `${d.type} ${JSON.stringify(d.message)} was dismissed; resend step ${i} with dialog: "accept" to confirm` : null
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** What a step acts on, for its StepResult and activity entry. Never a filled value; files by base name only. */
export function stepTarget(step: Step): string | undefined {
  switch (step.action) {
    case "click":
    case "fill":
    case "select":
    case "upload": {
      const t = step.target
      if (typeof t === "string") return t
      const head = "ref" in t ? t.ref : `"${t.text}"${t.within ? ` within "${t.within}"` : ""}`
      return step.action === "upload" ? `${head} ← ${step.files.map(baseName).join(", ")}` : head
    }
    case "goto":
      return step.url
    case "press":
      return step.key
    case "scroll":
      return step.px ? `${step.direction} ${step.px}` : step.direction
    case "switch_tab":
      return String(step.to)
    case "wait":
      return step.ms !== undefined ? `${step.ms} ms` : undefined
  }
}

/** Registrable domain of a page URL; "" for pages without a host (about:blank, data:, unparsable). */
export function siteOf(url: string): string {
  try {
    if (!new URL(url).hostname) return ""
  } catch {
    return ""
  }
  return registrableDomain(url)
}

/** Domains the guard accepts besides the start page's: allow_domains, goto URLs and expect.url values. */
export function allowedSites(params: BatchParams): Set<string> {
  const out = new Set<string>()
  const add = (u: string) => {
    const site = siteOf(u.includes("://") ? u : `https://${u}`)
    if (site) out.add(site)
  }
  for (const d of params.allow_domains ?? []) add(d)
  for (const step of params.steps) {
    if (step.action === "goto") add(step.url)
    if (step.expect && "url" in step.expect && /^https?:\/\//.test(step.expect.url)) add(step.expect.url)
  }
  return out
}

/** `expect.url`: substring, or a regex when wrapped in `/…/`. */
export function urlMatches(url: string, want: string): boolean {
  if (want.length > 2 && want.startsWith("/") && want.endsWith("/")) {
    try {
      return new RegExp(want.slice(1, -1)).test(url)
    } catch {
      return false
    }
  }
  return url.includes(want)
}

export function capDiff(d: Diff, n = BATCH_DIFF_MAX_LINES): Diff {
  return { added: d.added.slice(0, n), removed: d.removed.slice(0, n) }
}

const bytes = (r: BatchResult): number => new TextEncoder().encode(JSON.stringify(r)).length

/** Keeps the serialized result within 900 KB: drops diff lines first, then shortens the page brief. */
export function fitResult(r: BatchResult, max = BATCH_RESULT_MAX_BYTES): BatchResult {
  let out = r
  while (bytes(out) > max && (out.diff.added.length || out.diff.removed.length)) {
    const half = (a: string[]) => a.slice(0, Math.floor(a.length / 2))
    out = { ...out, diff: { added: half(out.diff.added), removed: half(out.diff.removed) } }
  }
  for (let size = bytes(out); size > max && out.page.length; size = bytes(out)) {
    out = { ...out, page: out.page.slice(0, Math.max(0, out.page.length - (size - max) - 64)) }
  }
  return out
}
