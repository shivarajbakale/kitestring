export const HOST_NAME = "com.kitestring.bridge"
export const LEGACY_HOST_NAMES = ["com.bx.bridge"] as const
export const PRODUCT = "Kitestring"
export const REF_RE = /^@e[0-9a-z]{5}$/
export const MAX_HOST_TO_CHROME = 1024 * 1024
export const READY = { quietMs: 300, timeoutMs: 10000 } as const
/**
 * Matched against the full request URL (not just the host). Telemetry beacons fire every few hundred ms on some sites
 * (GitHub: collector.github.com, /_private/browser/rum and /errors), so a page waiting on them is never idle.
 */
export const ANALYTICS_HOST_RE =
  /google-analytics|googletagmanager|doubleclick|segment|hotjar|mixpanel|sentry|datadoghq|browser-intake|collector\.github\.com|\/_private\/browser\/(?:rum|errors|stats)|\/rum\?/
/** A request in flight this long stops counting toward network idle: long polls, and requests that never report back. */
export const STALE_REQUEST_MS = 5_000
/** Never idle by nature. Media: a playing <video> / <audio> streams range requests back to back for as long as it plays. */
export const IGNORED_RESOURCE_TYPES = ["WebSocket", "EventSource", "Ping", "Media"] as const
/** Stable extension id derived from the public key in packages/extension/package.json (manifest.key). */
export const EXTENSION_ID = "bdfegcbeenjmlbfogodoibdhfbonnicm"
/** Extension id the Chrome Web Store assigns on the first upload; empty until then. The native host allows it in addition to EXTENSION_ID. */
export const KITE_STORE_EXTENSION_ID = ""
/** Longest one human.ask call waits: under the MCP tool bound, so the agent asks again instead of timing out. */
export const HANDOFF_WAIT_MS = 40_000
export const HANDOFF_REASON_MAX = 200
