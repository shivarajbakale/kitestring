import { describe, expect, it } from "vitest"
import { registrableDomain, sameSite } from "../src/index.js"

describe("registrableDomain", () => {
  it("returns eTLD+1", () => {
    expect(registrableDomain("https://www.example.com/a")).toBe("example.com")
    expect(registrableDomain("https://accounts.example.co.uk")).toBe("example.co.uk")
    expect(registrableDomain("https://foo.github.io")).toBe("foo.github.io")
    expect(registrableDomain("https://a.b.foo.vercel.app/x")).toBe("foo.vercel.app")
  })
  it("uses the full host for IPs and localhost", () => {
    expect(registrableDomain("http://127.0.0.1:4173/x")).toBe("127.0.0.1")
    expect(registrableDomain("http://localhost:9/")).toBe("localhost")
  })
})

describe("sameSite", () => {
  it("compares registrable domains", () => {
    expect(sameSite("https://a.x.com", "https://b.x.com")).toBe(true)
    expect(sameSite("https://a.x.com", "https://a.y.com")).toBe(false)
    expect(sameSite("http://127.0.0.1:1", "http://localhost:1")).toBe(false)
  })
})
