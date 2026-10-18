import { test as base, expect, type Page } from "@playwright/test"
import { build } from "esbuild"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
async function buildBundle(): Promise<string> {
  const res = await build({
    stdin: {
      contents: [
        `import { createAgent } from "./src/index.ts"`,
        `import { fileInputFor } from "./src/files.ts"`,
        `import { startRecorder } from "./src/recorder.ts"`,
        `window.__kiteAgent = createAgent(window)`,
        `window.__fileInputFor = fileInputFor`,
        `window.__startRecorder = startRecorder`
      ].join("\n"),
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
  await loadPage(page, join(here, "fixtures", name))
}

/** Loads any HTML file (e.g. a torture page) and injects the agent bundle. */
export async function loadPage(page: Page, file: string): Promise<void> {
  cached ??= buildBundle()
  await page.goto(pathToFileURL(file).href)
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
