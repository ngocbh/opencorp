import { expect, test } from "@playwright/test"
import { acme, session } from "./company"

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

const live = (page: import("@playwright/test").Page, name: string) =>
  panel(page, name).getByRole("list", { name: "Live sessions" }).getByRole("listitem")

test("live sessions show status, cost and office; a harness session is unpriced", async ({ page }) => {
  await page.getByRole("treeitem", { name: /Lead/ }).click()
  await expect(live(page, "Lead")).toHaveText(["idle · $0.00 · mac"])
  await page.getByRole("treeitem", { name: /Kai/ }).click()
  await expect(live(page, "Kai")).toHaveText(["idle · $0.42 · mac"])
  await page.getByRole("treeitem", { name: /Minh/ }).click()
  await expect(live(page, "Minh").first()).toContainText("busy · unpriced · mac")
  await page.getByRole("treeitem", { name: /Ann/ }).click()
  await expect(panel(page, "Ann")).toContainText("Live sessionsNone")
})

test("only the person's own main and side sessions are live work", async ({ page, request }) => {
  const sessions = [
    ...acme().sessions,
    session("S-ann-side", "ann", "busy", { kind: "side", office: "misha" }),
    session("S-ann-profile", "ann", "busy", { kind: "profile_manager" }),
  ]
  await request.post("/__fixture/set", { data: { sessions } })
  await page.reload()
  await page.getByRole("radio", { name: "List" }).click()
  await page.getByRole("treeitem", { name: /Ann/ }).click()
  await expect(live(page, "Ann")).toHaveText(["busy · $0.00 · misha"])
})
