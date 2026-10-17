import { test as base, expect, type Page } from "@playwright/test"
import { build } from "esbuild"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
async function buildBundle(): Promise<string> {
  const res = await build({
    stdin: {
      contents: `import { createAgent } from "./src/index.ts"; window.__bxAgent = createAgent(window)`,
      resolveDir: join(here, ".."),
      loader: "ts"
    },
    bundle: true,
    format: "iife",
    write: false
  })
  return res.outputFiles[0].text
}

let cached: Promise<string> | undefined

export async function loadFixture(page: Page, name: string): Promise<void> {
  cached ??= buildBundle()
  await page.goto(pathToFileURL(join(here, "fixtures", name)).href)
  await page.addScriptTag({ content: await cached })
}

export const test = base.extend<{ fixture: (name: string) => Promise<Page> }>({
  fixture: async ({ page }, use) => {
    await use(async (name) => {
      await loadFixture(page, name)
      return page
    })
  }
})

export { expect }
