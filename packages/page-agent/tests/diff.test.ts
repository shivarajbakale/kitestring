import { describe, expect, it } from "vitest"
import { diffSnapshots } from "../src/diff.js"

describe("diffSnapshots", () => {
  it("returns added and removed lines, ignoring header and indentation", () => {
    const before = 'page "A" http://x/\nmain\n  button "Save" [@e00001]\n  link "Old" [@e00002]'
    const after = 'page "B" http://x/y\nmain\n    button "Save" [@e00001]\n  link "New" [@e00003]\n'
    expect(diffSnapshots(before, after)).toEqual({ added: ['link "New" [@e00003]'], removed: ['link "Old" [@e00002]'] })
  })
  it("counts duplicates", () => {
    const d = diffSnapshots("a\nb\nb", "b\nb\nb\na\na")
    expect(d).toEqual({ added: ["b", "a"], removed: [] })
    expect(diffSnapshots("a\na", "a")).toEqual({ added: [], removed: ["a"] })
  })
  it("empty when identical or only header differs", () => {
    expect(diffSnapshots('page "A" u\nx', 'page "B" v\nx')).toEqual({ added: [], removed: [] })
  })
})
