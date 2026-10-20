import { expect, test, type Page } from "@playwright/test"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

/** Opens the company view on the chart. */
async function openChart(page: Page) {
  await page.goto("/")
  await page.getByRole("radio", { name: "Chart" }).click()
  const chart = page.getByRole("figure", { name: "Acme org chart" })
  await expect(chart.getByRole("button", { name: "Ngoc, CEO" })).toBeVisible()
  return chart
}

/** The canvas's transform as [k, x, y]. */
const transform = async (page: Page) =>
  (await page.getByTestId("chart-canvas").getAttribute("data-transform"))!.split(",").map(Number)

test("cards and elbow lines, one line per drawn manager and report", async ({ page }) => {
  const chart = await openChart(page)
  await expect(chart.getByRole("button", { name: "Ann, Designer" })).toBeVisible()
  await expect(chart.locator("svg path[data-edge]")).toHaveCount(4) // ngocbh>ann, ngocbh>lead, lead>kai, lead>minh
  await expect(chart.locator('path[data-edge="lead>kai"]')).toHaveAttribute("d", /^M [\d.]+ [\d.]+ V [\d.]+ H [\d.]+ V [\d.]+$/)
  // A card says what the list's row says: status, cards for the viewer, cost.
  await expect(chart.getByRole("button", { name: "Kai, Engineer" }).getByTestId("status")).toHaveAttribute("data-status", "waiting")
  await expect(chart.getByRole("button", { name: "Kai, Engineer" }).getByTestId("needs-you")).toHaveText("1")
  await expect(chart.getByRole("button", { name: "Minh, Engineer" }).getByTestId("cost")).toHaveText("$0.00 +1 unpriced")
  await expect(chart.getByRole("button", { name: "Kai, Engineer" })).toHaveAccessibleDescription("waiting · 1 card for you · $0.42")
})
