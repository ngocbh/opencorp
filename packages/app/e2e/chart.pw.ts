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

test("dragging pans the chart by the pointer's travel, even when it starts on a card", async ({ page }) => {
  const chart = await openChart(page)
  const [, x0, y0] = await transform(page)
  const card = (await chart.getByRole("button", { name: "Ann, Designer" }).boundingBox())!
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2)
  await page.mouse.down()
  await page.mouse.move(card.x + card.width / 2 + 100, card.y + card.height / 2 + 20, { steps: 5 })
  await page.mouse.up()
  const [, x1, y1] = await transform(page)
  expect([Math.round(x1 - x0), Math.round(y1 - y0)]).toEqual([100, 20])
  await expect(page.getByRole("complementary")).toHaveCount(0) // a drag isn't a click
  // A drag on the background pans too.
  const view = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(view.x + 10, view.y + 10)
  await page.mouse.down()
  await page.mouse.move(view.x + 40, view.y + 10, { steps: 3 })
  await page.mouse.up()
  expect(Math.round((await transform(page))[1] - x1)).toBe(30)
})

test("after a drag, a click or Enter on a card opens the side panel again", async ({ page }) => {
  const chart = await openChart(page)
  const ann = chart.getByRole("button", { name: "Ann, Designer" })
  const card = (await ann.boundingBox())!
  await page.mouse.move(card.x + 20, card.y + 20)
  await page.mouse.down()
  await page.mouse.move(card.x + 60, card.y + 20, { steps: 3 })
  await page.mouse.up()
  await ann.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("complementary", { name: "Ann" })).toBeVisible()
})

test("the wheel and the buttons zoom; Fit goes back to the whole chart", async ({ page }) => {
  await openChart(page)
  const fitted = await page.getByTestId("chart-canvas").getAttribute("data-transform")
  const box = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const [k0] = await transform(page)
  await page.mouse.wheel(0, -300)
  await expect.poll(async () => (await transform(page))[0]).toBeGreaterThan(k0)
  const [k1] = await transform(page)
  await page.getByRole("button", { name: "Zoom out" }).click()
  expect((await transform(page))[0]).toBeLessThan(k1)
  await page.getByRole("button", { name: "Zoom in" }).click()
  await page.getByRole("button", { name: "Fit" }).click()
  expect(await page.getByTestId("chart-canvas").getAttribute("data-transform")).toBe(fitted)
})

test("the wheel over the chart doesn't scroll the page", async ({ page }) => {
  await openChart(page)
  const box = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 300)
  await expect.poll(async () => (await transform(page))[0]).toBeLessThan(1)
  expect(await page.evaluate(() => scrollY)).toBe(0)
})
