import { z } from "zod"

export const METHODS = [
  "status",
  "tab.new",
  "tab.list",
  "tab.close",
  "tab.use",
  "page.goto",
  "page.snapshot",
  "act.click",
  "act.fill",
  "act.press",
  "act.select",
  "act.scroll",
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
