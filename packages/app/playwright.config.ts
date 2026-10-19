import { defineConfig, devices } from "@playwright/test"

const PORT = 4791

export default defineConfig({
  testDir: "e2e",
  // Not *.test.ts or *.spec.ts: `bun test` would pick those up.
  testMatch: /.*\.pw\.ts$/,
  // One fixture server with shared state: tests run one at a time and reset it first.
  workers: 1,
  fullyParallel: false,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun run build && bun e2e/fixture.ts --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
