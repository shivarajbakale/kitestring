import { defineConfig } from "@playwright/test"

// Expects `pnpm build` to have run (extension build + CLI dist).
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  reporter: "line",
  workers: 1,
  timeout: 60_000,
})
