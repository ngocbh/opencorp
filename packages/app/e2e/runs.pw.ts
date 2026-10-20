import { expect, test, type Page } from "@playwright/test"
import { crowded, many, rid } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const table = (page: Page) => page.getByRole("table", { name: "Runs" })
const row = (page: Page, n: number) => table(page).getByRole("row").filter({ hasText: rid(n).slice(-8) })

test("one row per top-level run, newest first, with every column", async ({ page }) => {
  await page.goto("/runs")
  const rows = table(page).getByRole("row")
  await expect(rows.nth(1)).toContainText(rid(5).slice(-8))
  await expect(row(page, 5)).toContainText("idle")
  await expect(row(page, 5)).toContainText("chat#3/ask")
  await expect(row(page, 4)).toContainText("chat#2/reply")
  await expect(row(page, 3)).toContainText("asking · chat#1/reply")
  await expect(row(page, 2)).toContainText("debrief of a Codex session")
  await expect(row(page, 2)).toContainText("office")
  await expect(row(page, 1)).toContainText("the office stopped")
  await expect(page.getByText("Codex sessions themselves aren't listed")).toBeVisible()
})

test("a run's children fold under it, and the copy button copies the full id", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/runs")
  await expect(row(page, 6)).toHaveCount(0)
  await row(page, 5).getByRole("button", { name: /Runs under/ }).click()
  await expect(row(page, 6)).toContainText("side_chat")
  await expect(row(page, 6)).toContainText("ann")
  await row(page, 5).getByRole("button", { name: "Copy run id" }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(rid(5))
})

test("a fresh run and the run it replaced link to each other", async ({ page }) => {
  await page.goto("/runs")
  await expect(row(page, 5).getByRole("link", { name: `replaces …${rid(4).slice(-4)}` })).toHaveAttribute(
    "href", `/runs/${rid(4)}`)
  await expect(row(page, 4).getByRole("link", { name: `replaced by …${rid(5).slice(-4)}` })).toHaveAttribute(
    "href", `/runs/${rid(5)}`)
})

test("filters and search live in the address; a parent shows when a child matches, opened", async ({ page }) => {
  await page.goto("/runs")
  await page.getByRole("combobox", { name: "Flow" }).selectOption("side_chat")
  await expect(page).toHaveURL("/runs?flow=side_chat")
  await expect(table(page).getByRole("row")).toHaveCount(3) // header, run 5, its side chat (open: it matches)
  await page.getByRole("combobox", { name: "Flow" }).selectOption("")
  await page.getByRole("combobox", { name: "Person" }).selectOption("lead")
  await expect(row(page, 3)).toBeVisible()
  await expect(row(page, 5)).toHaveCount(0)
  await page.goto("/runs?status=failed")
  await expect(table(page).getByRole("row")).toHaveCount(2)
  await page.getByRole("searchbox", { name: "Search runs" }).fill(rid(2).slice(-5))
  await page.getByRole("searchbox", { name: "Search runs" }).press("Enter")
  await expect(page).toHaveURL(/q=/)
})

test("an exact run id in search opens the run", async ({ page }) => {
  await page.goto("/runs")
  await page.getByRole("searchbox", { name: "Search runs" }).fill(rid(3).toLowerCase())
  await page.getByRole("searchbox", { name: "Search runs" }).press("Enter")
  await expect(page).toHaveURL(`/runs/${rid(3)}`)
})

test("pages hold 50 top-level runs, each with its children; Load more brings the next", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: many(120) } })
  await page.goto("/runs")
  const tops = table(page).locator("tr[aria-level='1']")
  await expect(tops).toHaveCount(50)
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(tops).toHaveCount(100)
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(tops).toHaveCount(120)
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0)
})

test("a run with more than 200 children shows the newest 200 and Show all", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: crowded(201) } })
  await page.goto("/runs")
  await table(page).getByRole("button", { name: /Runs under/ }).click()
  await expect(table(page).locator("tr[aria-level='2']")).toHaveCount(200)
  await page.getByRole("button", { name: "Show all 201" }).click()
  await expect(table(page).locator("tr[aria-level='2']")).toHaveCount(201)
})

test("run.updated refetches the list", async ({ page, request }) => {
  await page.goto("/runs")
  await expect(row(page, 3)).toContainText("waiting")
  await request.post("/__fixture/set", { data: { runs: { runs: [], children: {} } } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(3), session_id: "S3", status: "finished", current_nodes: [] } } } })
  await expect(table(page).getByRole("row")).toHaveCount(1) // only the header: the refetch read the emptied office
})

test("on a phone each row stacks into two lines", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/runs")
  const box = (await row(page, 5).boundingBox())!
  expect(box.width).toBeLessThanOrEqual(390)
  await expect(row(page, 5).getByTestId("run-second-line")).toBeVisible()
})
