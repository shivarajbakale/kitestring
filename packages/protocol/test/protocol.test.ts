import { describe, expect, it } from "vitest"
import { parseTarget, RpcRequest } from "../src/index.js"

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
