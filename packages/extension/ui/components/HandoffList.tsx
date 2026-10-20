import { useState } from "react"
import type { UiHandoff } from "../messages"
import { RelativeTime } from "./RelativeTime"

interface Props {
  handoffs: UiHandoff[]
  onShow: (h: UiHandoff) => void
  /** Resolves null (or undefined) when the answer was not applied. */
  onAnswer: (h: UiHandoff, outcome: "done" | "declined") => Promise<unknown>
}

/** Agents waiting on the person: what they need, and the two answers that let them go on. */
export function HandoffList({ handoffs, onShow, onAnswer }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  if (!handoffs.length) return null

  const answer = async (h: UiHandoff, outcome: "done" | "declined") => {
    setBusy(h.session)
    try {
      await onAnswer(h, outcome)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="ks-handoffs" aria-label="Agents waiting for you">
      {handoffs.map((h) => (
        <article key={h.session} className="ks-handoff" role="status">
          <p className="ks-handoff__who">
            <span className="ks-dot ks-dot--warn" aria-hidden="true" />
            <strong>{h.session}</strong> needs you
            <RelativeTime ts={h.since} />
          </p>
          <p className="ks-handoff__reason">{h.reason}</p>
          <div className="ks-handoff__actions">
            <button type="button" className="ks-btn ks-btn--ink" disabled={busy === h.session} onClick={() => void answer(h, "done")}>
              Done
            </button>
            <button type="button" className="ks-btn ks-btn--quiet" disabled={busy === h.session} onClick={() => void answer(h, "declined")}>
              Can’t do it
            </button>
            {h.tabId !== null ? (
              <button type="button" className="ks-link ks-handoff__show" onClick={() => onShow(h)}>
                Show tab
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </section>
  )
}
