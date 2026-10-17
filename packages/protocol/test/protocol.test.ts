import { describe, expect, it } from "vitest"
import { ErrorCode, parseTarget, RpcRequest, RpcResponse } from "../src/index.js"

describe("parseTarget", () => {
  it("parses a ref", () => {
    expect(parseTarget("@e1k2d9")).toEqual({ ref: "@e1k2d9" })
  })
  it("parses text with within", () => {
    expect(parseTarget("Save", { within: "Profile" })).toEqual({ text: "Save", within: "Profile" })
  })
  it("treats a malformed ref as text", () => {
    expect(parseTarget("@notaref")).toEqual({ text: "@notaref" })
  })
})

describe("RpcRequest", () => {
  it("accepts a valid method", () => {
    expect(RpcRequest.safeParse({ id: 1, method: "act.click", params: {}, session: "default" }).success).toBe(true)
  })
  it("rejects an unknown method", () => {
    expect(RpcRequest.safeParse({ id: 1, method: "nope", params: {}, session: "x" }).success).toBe(false)
  })
})

describe("RpcResponse", () => {
  it("round-trips an error response unchanged", () => {
    const e = { id: 1, error: { code: "X", message: "m" } }
    expect(RpcResponse.parse(e)).toEqual(e)
  })
  it("round-trips a result response unchanged", () => {
    const r = { id: 2, result: { a: 1 } }
    expect(RpcResponse.parse(r)).toEqual(r)
  })
  it("rejects an object with neither result nor error", () => {
    expect(RpcResponse.safeParse({ id: 3 }).success).toBe(false)
  })
})

describe("ErrorCode", () => {
  it("includes TIMEOUT", () => {
    expect(ErrorCode.TIMEOUT).toBe("TIMEOUT")
  })
})
