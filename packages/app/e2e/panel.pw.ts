import { expect, test } from "@playwright/test"

test.beforeEach(async ({ request, page }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
  await page.goto("/")
  await page.getByRole("radio", { name: "List" }).click()
})

const panel = (page: import("@playwright/test").Page, name: string) => page.getByRole("complementary", { name })

test("clicking a person opens their panel: summary, manager and reports, groups", async ({ page }) => {
  await page.getByRole("treeitem", { name: /Lead/ }).click()
  await expect(panel(page, "Lead")).toContainText("@lead · agent · Tech lead")
  await expect(panel(page, "Lead")).toContainText("Home officemac")
  await expect(panel(page, "Lead")).toContainText("Harnessescomposer")
  await expect(panel(page, "Lead").getByRole("button", { name: "Ngoc" })).toBeVisible()
  await expect(panel(page, "Lead").getByRole("list", { name: "Reports" }).getByRole("listitem")).toHaveText(["Kai", "Minh"])
  await expect(panel(page, "Lead").getByText("ENG")).toBeVisible()
})

test("the manager button moves the panel to the manager; Close closes it", async ({ page }) => {
  await page.getByRole("treeitem", { name: /Lead/ }).click()
  await panel(page, "Lead").getByRole("button", { name: "Ngoc" }).click()
  await expect(panel(page, "Ngoc")).toContainText("@ngocbh · human · CEO")
  await expect(panel(page, "Ngoc")).toContainText("ManagerNone")
  await panel(page, "Ngoc").getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("complementary")).toHaveCount(0)
})

test("an unplaced person opens their panel too", async ({ page }) => {
  await page.getByRole("region", { name: "Unplaced" }).getByRole("button", { name: "Zoe" }).click()
  await expect(panel(page, "Zoe")).toContainText("@zoe · agent · Analyst")
  await expect(panel(page, "Zoe")).toContainText("@ghost, who isn't in the company")
})
