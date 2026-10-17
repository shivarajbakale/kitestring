import type { GroupColor } from "../messages"
import { SessionDot } from "./SessionDot"

export interface FilterOption {
  name: string
  color: GroupColor
  count: number
}

interface Props {
  options: FilterOption[]
  total: number
  /** null shows every session. */
  selected: string | null
  onSelect: (name: string | null) => void
}

/** One chip per session plus All; single choice, so a chip pressed again goes back to All. */
export function SessionFilter({ options, total, selected, onSelect }: Props) {
  return (
    <div className="ks-chips" role="group" aria-label="Filter by session">
      <button type="button" className="ks-chip" aria-pressed={selected === null} onClick={() => onSelect(null)}>
        All
        <span className="ks-chip__count">{total}</span>
      </button>
      {options.map((o) => (
        <button
          key={o.name}
          type="button"
          className="ks-chip"
          aria-pressed={selected === o.name}
          onClick={() => onSelect(selected === o.name ? null : o.name)}>
          <SessionDot color={o.color} />
          <span className="ks-chip__name">{o.name}</span>
          <span className="ks-chip__count">{o.count}</span>
        </button>
      ))}
    </div>
  )
}
