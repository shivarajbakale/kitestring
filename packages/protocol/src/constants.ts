export const HOST_NAME = "com.kitestring.bridge"
export const LEGACY_HOST_NAMES = ["com.bx.bridge"] as const
export const PRODUCT = "Kitestring"
export const REF_RE = /^@e[0-9a-z]{5}$/
export const MAX_HOST_TO_CHROME = 1024 * 1024
export const READY = { quietMs: 300, timeoutMs: 10000 } as const
/** Matched against the full request URL (not just the host). */
export const ANALYTICS_HOST_RE = /google-analytics|googletagmanager|doubleclick|segment|hotjar|mixpanel|sentry|datadoghq/
export const IGNORED_RESOURCE_TYPES = ["WebSocket", "EventSource", "Ping"] as const
/** Stable extension id derived from the public key in packages/extension/package.json (manifest.key). */
export const EXTENSION_ID = "bdfegcbeenjmlbfogodoibdhfbonnicm"
