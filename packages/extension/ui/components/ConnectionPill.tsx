export function ConnectionPill({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="ks-pill" role="status">
      <span className="ks-dot ks-dot--ok" aria-hidden="true" />
      <span>Connected</span>
    </span>
  ) : (
    <span className="ks-pill ks-pill--off" role="status">
      <span className="ks-dot ks-dot--warn" aria-hidden="true" />
      <span>
        Not connected — run <code>kite doctor</code>
      </span>
    </span>
  )
}
