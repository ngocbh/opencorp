import { defineConfig, devices } from "@playwright/test"

// Against a running office: HQ_PAIR_URL is the link `opencorp pair --no-open` printed (single use, 5 minutes).
const url = process.env.HQ_PAIR_URL ?? ""

export default defineConfig({
  testDir: "e2e",
  testMatch: /real\.pw\.ts$/,
  workers: 1,
  // No trace or HTML report: they would keep what the test typed, a password included.
  reporter: "list",
  use: { baseURL: url ? new URL(url).origin : undefined, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
