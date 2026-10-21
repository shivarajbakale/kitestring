import { useEffect, useState } from "react"

/** "just now", "12s ago", "4m ago", "3h ago", "2d ago". */
export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Re-renders every `ms`, for live relative times. */
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** "0:42", "4:05", "1:02:10": how long something has been going on. */
export function elapsed(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  const pad = (n: number) => String(n).padStart(2, "0")
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** A ticking stopwatch since `ts`, for someone who is waiting. */
export function Elapsed({ ts }: { ts: number }) {
  const now = useNow(1000)
  return (
    <time className="ks-time ks-elapsed" dateTime={new Date(ts).toISOString()} title={`Since ${new Date(ts).toLocaleTimeString()}`}>
      {elapsed(ts, now)}
    </time>
  )
}

export function RelativeTime({ ts, prefix = "" }: { ts: number; prefix?: string }) {
  const now = useNow()
  return (
    <time className="ks-time" dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString()}>
      {prefix}
      {relativeTime(ts, now)}
    </time>
  )
}
