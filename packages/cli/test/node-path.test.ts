import { expect, it } from "vitest"
import { nodeCandidates, resolveNode } from "../src/init/node-path.js"

const cellar = "/opt/homebrew/Cellar/node/25.1.0/bin/node"

it("puts /opt/homebrew/bin/node first for a Cellar execPath", () => {
  const exists = (p: string) => p === "/opt/homebrew/bin/node" || p === cellar
  const c = nodeCandidates({ execPath: cellar, exists })
  expect(c[0]).toBe("/opt/homebrew/bin/node")
  expect(c).toContain(cellar)
  expect(c[c.length - 1]).toBe(cellar)
  expect(resolveNode({ execPath: cellar, exists })).toBe("/opt/homebrew/bin/node")
})

it("puts a non-Cellar execPath first", () => {
  const p = "/Users/x/.nvm/versions/node/v22/bin/node"
  const c = nodeCandidates({ execPath: p, exists: () => true })
  expect(c[0]).toBe(p)
  expect(new Set(c).size).toBe(c.length)
})

it("skips missing candidates but keeps execPath as last resort", () => {
  const c = nodeCandidates({ execPath: cellar, exists: () => false })
  expect(c).toEqual([cellar])
  expect(resolveNode({ execPath: cellar, exists: () => false })).toBe(cellar)
})
