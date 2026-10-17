/** The Kitestring mark (brand/mark-small.svg, the cut for 32 px and below), colored from the theme. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <path
        fill="var(--ks-ink)"
        d="M31.27 6.06 L83.56 6.06 L83.56 248.5 L31.27 248.5 Z M83.56 170.07 L123.96 170.07 L202.4 248.5 L147.73 248.5 L83.56 184.33 Z"
      />
      <path fill="var(--ks-accent)" d="M83.56 143.92 L210.89 90.54 L224.73 2.74 L136.94 16.59 Z" />
    </svg>
  )
}
