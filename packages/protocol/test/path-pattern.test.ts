import { describe, expect, it } from "vitest"
import { pathPattern } from "../src/index.js"

describe("pathPattern", () => {
  it("replaces numeric segments", () => {
    expect(pathPattern("https://a.test/a/123/b")).toBe("/a/*/b")
    expect(pathPattern("/a/123/b")).toBe("/a/*/b")
  })
  it("replaces uuids", () => {
    expect(pathPattern("https://a.test/o/3f2b8c1e-9d4a-4e7b-8a21-5c6d7e8f9a0b/edit")).toBe("/o/*/edit")
  })
  it("replaces long hex and base64-ish segments", () => {
    expect(pathPattern("https://a.test/t/0123456789abcdef0123")).toBe("/t/*")
    expect(pathPattern("https://a.test/s/Zm9vYmFyMTIzNDU2Nzg5")).toBe("/s/*")
  })
  it("keeps words, short ids and slugs", () => {
    expect(pathPattern("https://a.test/settings/profile")).toBe("/settings/profile")
    expect(pathPattern("https://a.test/blog/my-long-article-title")).toBe("/blog/my-long-article-title")
    expect(pathPattern("https://a.test/x/abc12")).toBe("/x/abc12")
  })
  it("leaves query and fragment out", () => {
    expect(pathPattern("https://a.test/a/1?x=2#top")).toBe("/a/*")
  })
  it("root and trailing slash", () => {
    expect(pathPattern("https://a.test")).toBe("/")
    expect(pathPattern("https://a.test/a/1/")).toBe("/a/*/")
  })
})
