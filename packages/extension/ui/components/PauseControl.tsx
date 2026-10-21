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
 * The human's switch. Running is the normal state, so it is a calm status bar with the switch at hand
 * (still one click: pausing must be fast). Paused is the exception and takes the room it needs: how long,
 * an optional reason agents receive in their PAUSED error, and Resume.
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
    const working = agentTabs > 0
    return (
      <section className="ks-control" data-paused="false" data-working={working || undefined} aria-label="Agent control">
        <span className="ks-control__live" aria-hidden="true" />
        <p className="ks-control__state">
          <strong>{working ? "Agents working" : "Agents idle"}</strong>
          <span>{working ? `in ${agentTabs === 1 ? "1 tab" : `${agentTabs} tabs`}` : "They open tabs as they need them"}</span>
        </p>
        <button
          type="button"
          className="ks-btn ks-btn--quiet ks-control__pause"
          aria-label="Pause agents"
          title="Pause agents: they stop before their next action"
          disabled={busy}
          onClick={() => run(() => onPause())}>
          <PauseIcon size={14} />
          Pause
        </button>
      </section>
    )
  }

  return (
    <section className="ks-control" data-paused="true" aria-label="Agent control">
      <span className="ks-control__glyph" aria-hidden="true">
        <PauseIcon size={14} />
      </span>
      <p className="ks-control__state">
        <strong>Agents paused</strong>
        <span>{since ? <RelativeTime ts={since} prefix="since " /> : "Nothing runs until you resume"}</span>
      </p>
      <button type="button" className="ks-btn ks-btn--ink ks-control__pause" disabled={busy} onClick={() => run(onResume)}>
        <PlayIcon size={14} />
        Resume
      </button>
      <form className="ks-field ks-control__reason" onSubmit={saveReason}>
        <label htmlFor={id}>Tell agents why (optional)</label>
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
    </section>
  )
}
