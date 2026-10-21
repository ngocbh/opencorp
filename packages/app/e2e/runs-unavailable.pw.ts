// Run Logs on an office older than its routes: /api/runs answers 404 no_route, as the office does for an unknown path.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { session } from "./company"
import { rid } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true, noRuns: true } })
})

const MESSAGE = "Run Logs aren't available on this office yet. Update and restart the office to see its runs."
const table = (page: Page) => page.getByRole("table", { name: "Runs" })

/** How many requests the app made to /api/runs and the routes under it. */
async function runReads(request: APIRequestContext) {
  const log = await (await request.get("/__fixture/log")).json()
  return (log.api as string[]).filter((p) => p === "/api/runs" || p.startsWith("/api/runs/")).length
}

/** Waits until the office is live and the page's read once it's first online (throttled to a second) is done. */
async function settle(page: Page) {
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  await page.waitForTimeout(1500)
}

/** Sends `run.updated` for run `n` and `session.updated`, as a busy office would. */
async function liveEvents(request: APIRequestContext, n: number) {
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(n), session_id: `S${n}`, status: "finished", current_nodes: [] } } } })
  await request.post("/__fixture/emit", { data: { event: { type: "session.updated", data: session("S-kai", "kai", "busy") } } })
}

test("the list says Run Logs aren't available yet, with no error and no Retry", async ({ page }) => {
  await page.goto("/runs")
  await expect(page.getByText(MESSAGE)).toBeVisible()
  await settle(page)
  await expect(page.getByText(MESSAGE)).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0)
  await expect(table(page)).toHaveCount(0)
  await expect(page.getByText("No runs.")).toHaveCount(0)
})

test("the list doesn't read again on live updates while the runs aren't available", async ({ page, request }) => {
  await page.goto("/runs")
  await expect(page.getByText(MESSAGE)).toBeVisible()
  await settle(page)
  const before = await runReads(request)
  for (let i = 0; i < 3; i++) await liveEvents(request, 3)
  await page.waitForTimeout(2500) // past the refetch throttle, twice
  expect(await runReads(request)).toBe(before)
})

test("the list checks again once the office is back, and shows the runs when the route has appeared", async ({ page, request }) => {
  await page.goto("/runs")
  await expect(page.getByText(MESSAGE)).toBeVisible()
  await settle(page)
  // The office restarts, updated.
  await request.post("/__fixture/set", { data: { noRuns: false } })
  await request.post("/__fixture/drop", { data: { ms: 1000 } })
  await expect(table(page).getByRole("row").filter({ hasText: rid(5).slice(-8) })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(MESSAGE)).toHaveCount(0)
})

test("a run page says Run Logs aren't available yet, reads nothing more on live updates, and checks again once the office is back", async ({ page, request }) => {
  await page.goto(`/runs/${rid(5)}`)
  await expect(page.getByText(MESSAGE)).toBeVisible()
  await settle(page)
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0)
  const before = await runReads(request)
  for (let i = 0; i < 3; i++) await liveEvents(request, 5)
  await page.waitForTimeout(2500)
  expect(await runReads(request)).toBe(before)
  await request.post("/__fixture/set", { data: { noRuns: false } })
  await request.post("/__fixture/drop", { data: { ms: 1000 } })
  await expect(page.getByRole("region", { name: "Run" })).toContainText("@ngocbh", { timeout: 15_000 })
  await expect(page.getByText(MESSAGE)).toHaveCount(0)
})

test("the person panel says recent runs aren't available, with no error and no link to them", async ({ page }) => {
  await page.goto("/org")
  await page.getByRole("radio", { name: "List" }).click()
  await page.getByRole("treeitem", { name: /Kai/ }).click()
  const recent = page.getByRole("complementary", { name: "Kai" }).getByRole("group", { name: "Recent runs" })
  await expect(recent).toContainText("Not available on this office yet")
  await expect(recent).not.toContainText("Couldn't read")
  await expect(recent.getByRole("link", { name: "All runs" })).toHaveCount(0)
})

test("a real failure still says why, with Retry", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { noRuns: false, fail: { "/api/runs": { status: 404, error: "not_found",
    message: "something else is missing" } } } })
  await page.goto("/runs")
  await expect(page.getByRole("alert")).toContainText("Couldn't read the runs: something else is missing.")
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible()
  await expect(page.getByText(MESSAGE)).toHaveCount(0)
})
