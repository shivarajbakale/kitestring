import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { REASON_MAX } from "../messages"
import { PauseIcon, PlayIcon } from "./icons"
import { RelativeTime } from "./RelativeTime"

interface Props {
  paused: boolean
  reason?: string
  since?: number
  /** Tabs the agents currently hold, for the running-state line. */
  agentTabs: number
  /** Resolves null (or undefined) when the pause was not applied. */
  onPause: (reason?: string) => Promise<unknown>
  onResume: () => Promise<unknown>
}

/**
 * The human's switch. Pausing is one click (it must be fast); once paused, an optional reason can be
 * added, which agents receive in their PAUSED error.
 */
export function PauseControl({ paused, reason, since, agentTabs, onPause, onResume }: Props) {
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(reason ?? "")
  const [saved, setSaved] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()

  // Follow changes made elsewhere (the CLI, the side panel) unless the user is typing.
  useEffect(() => {
    if (document.activeElement !== input.current) setDraft(reason ?? "")
  }, [reason])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const saveReason = async (e?: FormEvent) => {
    e?.preventDefault()
    if (draft.trim() === (reason ?? "")) return
    // act() resolves null when the background refused or failed.
    if ((await onPause(draft)) != null) setSaved(true)
  }

  if (!paused) {
    return (
      <section className="ks-control" data-paused="false" aria-label="Agent control">
        <p className="ks-control__state">
          <span className="ks-dot ks-dot--live" aria-hidden="true" />
          {agentTabs === 0
            ? "Agents can open tabs when they need them."
            : `Agents are working in ${agentTabs === 1 ? "1 tab" : `${agentTabs} tabs`}.`}
        </p>
        <button type="button" className="ks-btn ks-btn--accent ks-btn--block" disabled={busy} onClick={() => run(() => onPause())}>
          <PauseIcon />
          Pause agents
        </button>
      </section>
    )
  }

  return (
    <section className="ks-control" data-paused="true" aria-label="Agent control">
      <p className="ks-control__state">
        <span className="ks-control__glyph" aria-hidden="true">
          <PauseIcon size={12} />
        </span>
        <strong>Agents paused</strong>
        {since ? <RelativeTime ts={since} /> : null}
      </p>
      <form className="ks-field" onSubmit={saveReason}>
        <label htmlFor={id}>Reason (optional)</label>
        <input
          ref={input}
          id={id}
          value={draft}
          placeholder="e.g. checking the order myself"
          maxLength={REASON_MAX}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            setDraft(e.target.value)
            setSaved(false)
          }}
        />
        <p className="ks-field__hint" id={`${id}-hint`} aria-live="polite">
          {saved ? "Sent. Agents see it with PAUSED." : "Agents see it with PAUSED. Enter to send."}
        </p>
      </form>
      <button type="button" className="ks-btn ks-btn--ink ks-btn--block" disabled={busy} onClick={() => run(onResume)}>
        <PlayIcon />
        Resume
      </button>
    </section>
  )
}
