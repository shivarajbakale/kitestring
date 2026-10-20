import { z } from "zod"

export const METHODS = [
  "status",
  "tab.new",
  "tab.list",
  "tab.close",
  "tab.use",
  "page.goto",
  "page.snapshot",
  "page.console",
  "page.network",
  "page.screenshot",
  /** `{max?}`: the active tab's visible text -> `{text}` (a watch compares it run to run). */
  "page.text",
  /** `{near?, selector?, key?, pick?, max?}`: the active tab's best (or chosen) table or repeated list -> `ExtractResult`. */
  "page.extract",
  /** `{expression}`: evaluate JavaScript in the active tab's page (promises awaited) -> `{value}` (JSON; undefined when not serializable). */
  "page.eval",
  /**
   * `{cond, timeout_ms?}`: wait until a condition holds in the active tab (selector / target / text / count / url / fn /
   * idle; see the extension's wait.ts) -> `{ms, value?}`, or TIMEOUT naming what was last seen.
   */
  "page.wait",
  "act.click",
  "act.fill",
  "act.press",
  "act.select",
  "act.scroll",
  "act.batch",
  "act.upload",
  "control.pause",
  "control.resume",
  "control.state",
  "activity.list",
  "cache.stats",
  "cache.clear",
  /** `{name}`: record the human's actions in the session's active tab -> `{name, tab, url}`. */
  "record.start",
  /** Ends the recording -> `Recording` (`{name, url, steps, secrets, skipped}`; no values). `{peek: true}` returns it without ending it. */
  "record.stop",
  /**
   * `{reason, wait_ms?}`: ask the person at the browser to do something only they can (captcha, 2FA, login).
   * Opens a request (notification, badge, panel card) or keeps waiting on the open one -> `HandoffResult`.
   */
  "human.ask",
  /** `{title, message, tab?, url?}`: a one-way notification for the person; a click shows `tab` or opens `url` (a scheduled run's result). */
  "notify",
] as const

export type Method = (typeof METHODS)[number]

export const ErrorCode = {
  NOT_CONNECTED: "NOT_CONNECTED",
  NO_TAB: "NO_TAB",
  NOT_OWNER: "NOT_OWNER",
  RESTRICTED: "RESTRICTED",
  BAD_REQUEST: "BAD_REQUEST",
  INTERNAL: "INTERNAL",
  /** The browser did not answer in time (page never became scriptable, stuck call). */
  TIMEOUT: "TIMEOUT",
  /** The user paused Kitestring (popup / `kite pause`): nothing acts until resumed. */
  PAUSED: "PAUSED",
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const RpcRequest = z.object({
  id: z.number(),
  method: z.enum(METHODS),
  params: z.record(z.unknown()),
  session: z.string(),
})
export type RpcRequest = z.infer<typeof RpcRequest>

export const RpcResponse = z.union([
  z.object({ id: z.number(), error: z.object({ code: z.string(), message: z.string() }) }).strict(),
  z
    .object({ id: z.number(), result: z.unknown() })
    .strict()
    .refine((v) => "result" in v, { message: "result required" }),
])
export type RpcResponse = z.infer<typeof RpcResponse>
