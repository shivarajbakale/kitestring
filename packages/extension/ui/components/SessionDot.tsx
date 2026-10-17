import type { CSSProperties } from "react"
import type { GroupColor } from "../messages"

/** A square swatch in the color of the session's Chrome tab group. */
export function SessionDot({ color }: { color: GroupColor }) {
  return <span className="ks-session-dot" style={{ "--ks-group": `var(--ks-group-${color})` } as CSSProperties} aria-hidden="true" />
}
