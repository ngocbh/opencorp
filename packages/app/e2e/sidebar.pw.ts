import { expect, test, type Page } from "@playwright/test"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const nav = (page: Page) => page.getByRole("navigation", { name: "HQ" })
const org = (page: Page) => nav(page).getByRole("link", { name: "Org" })

test("/ goes to /org, replacing itself in the history, and Org is the current page", async ({ page }) => {
  await page.goto("/org")
  await expect(org(page)).toHaveAttribute("aria-current", "page")
  const entries = await page.evaluate(() => history.length)
  await page.goto("/")
  await expect(page).toHaveURL("/org")
  await expect(page.getByRole("tree").or(page.getByRole("figure"))).toBeVisible()
  expect(await page.evaluate(() => history.length)).toBe(entries + 1)
  await expect(org(page)).toHaveAttribute("aria-current", "page")
})

test("an address with no page says so inside the shell, with no item current", async ({ page }) => {
  await page.goto("/nowhere")
  await expect(page.getByRole("main")).toContainText("There's no page here.")
  await expect(nav(page).locator("[aria-current]")).toHaveCount(0)
  await org(page).click()
  await expect(page).toHaveURL("/org")
  await expect(org(page)).toHaveAttribute("aria-current", "page")
})
