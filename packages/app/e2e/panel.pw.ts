import { expect, test } from "@playwright/test"
import { acme, session, SHA } from "./company"

test.beforeEach(async ({ request, page }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
  await page.goto("/")
  // Phones always get the list, with no Chart / List switch.
  if (page.viewportSize()!.width >= 768) await page.getByRole("radio", { name: "List" }).click()
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

test("'now doing' is the work item's title, read when the panel opens", async ({ page, request }) => {
  const read = async () => (await (await request.get("/__fixture/log")).json()).workItems as string[]
  expect(await read()).not.toContain("W-minh")
  await page.getByRole("treeitem", { name: /Minh/ }).click()
  await expect(live(page, "Minh")).toHaveText(["busy · unpriced · mac · now doing: Fix the build"])
  expect(await read()).toContain("W-minh")
})

test("Enter opens it from the keyboard and focus moves in; Escape closes it and focus goes back to the row", async ({ page }) => {
  await page.getByRole("treeitem", { name: /Ann/ }).focus()
  await page.keyboard.press("Enter")
  await expect(panel(page, "Ann").getByRole("heading", { name: "Ann" })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("complementary")).toHaveCount(0)
  await expect(page.getByRole("treeitem", { name: /Ann/ })).toBeFocused()
})

test("Close sends focus back to the row that opened the panel, even after moving to the manager", async ({ page }) => {
  await page.getByRole("treeitem", { name: /Kai/ }).click()
  await panel(page, "Kai").getByRole("button", { name: "Lead" }).click()
  await expect(panel(page, "Lead").getByRole("heading", { name: "Lead" })).toBeFocused()
  await panel(page, "Lead").getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("treeitem", { name: /Kai/ })).toBeFocused()
})

test("Escape in the search box is the search box's", async ({ page }) => {
  await page.getByRole("treeitem", { name: /Lead/ }).click()
  await page.getByRole("searchbox", { name: "Search people" }).fill("k")
  await page.keyboard.press("Escape")
  await expect(panel(page, "Lead")).toBeVisible()
  await expect(page.getByRole("searchbox", { name: "Search people" })).toBeFocused()
})

test("the row of the panel's person is the selected one", async ({ page }) => {
  const row = (name: RegExp) => page.getByRole("treeitem", { name })
  await expect(row(/Lead/)).toHaveAttribute("aria-selected", "false")
  await row(/Lead/).click()
  await expect(row(/Lead/)).toHaveAttribute("aria-selected", "true")
  await expect(row(/Kai/)).toHaveAttribute("aria-selected", "false")
  await row(/Kai/).click()
  await expect(row(/Kai/)).toHaveAttribute("aria-selected", "true")
  await expect(row(/Lead/)).toHaveAttribute("aria-selected", "false")
  await panel(page, "Kai").getByRole("button", { name: "Close" }).click()
  await expect(page.locator("[role=treeitem][aria-selected=true]")).toHaveCount(0)
})

test("someone who leaves the company closes their panel, and coming back doesn't reopen it", async ({ page, request }) => {
  const commit = async (sha: string, people: ReturnType<typeof acme>["view"]["people"]) => {
    await request.post("/__fixture/set", { data: { view: { sha, people } } })
    await request.post("/__fixture/emit", { data: { event: { type: "company.updated", data: { sha } } } })
  }
  await page.getByRole("treeitem", { name: /Kai/ }).click()
  await expect(panel(page, "Kai")).toBeVisible()
  const search = page.getByRole("searchbox", { name: "Search people" })
  await search.focus()
  await commit(SHA.replace(/^0/, "f"), acme().view.people.filter((p) => p.handle !== "kai"))
  await expect(page.getByRole("treeitem", { name: /Kai/ })).toHaveCount(0)
  await expect(page.getByRole("complementary")).toHaveCount(0)
  await commit(SHA.replace(/^0/, "e"), acme().view.people)
  await expect(page.getByRole("treeitem", { name: /Kai/ })).toBeVisible()
  await expect(page.getByRole("complementary")).toHaveCount(0)
  await expect(search).toBeFocused()
})

/** The panel on a phone: a modal dialog. */
const sheet = (page: import("@playwright/test").Page, name: string) => page.getByRole("dialog", { name })

test("on a desktop the panel is a complementary region, not a dialog", async ({ page }) => {
  await page.getByRole("treeitem", { name: /Lead/ }).click()
  await expect(panel(page, "Lead")).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("the panel is a full-width sheet, and the list behind it can't take focus", async ({ page }) => {
    await page.getByRole("treeitem", { name: /Lead/ }).click()
    await expect(sheet(page, "Lead")).toHaveAttribute("aria-modal", "true")
    await expect(page.getByRole("complementary")).toHaveCount(0)
    const box = await sheet(page, "Lead").boundingBox()
    expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 })
    // The list is inert: a row can't take focus while the sheet is over it.
    await page.getByRole("treeitem", { name: /Kai/ }).evaluate((el: HTMLElement) => el.focus())
    await expect(page.getByRole("treeitem", { name: /Kai/ })).not.toBeFocused()
    await sheet(page, "Lead").getByRole("button", { name: "Close" }).click()
    await expect(page.getByRole("treeitem", { name: /Lead/ })).toBeFocused()
  })

  test("the sidebar behind the sheet can't take focus either, until it closes", async ({ page }) => {
    const company = page.locator('nav a[href="/"]')
    await page.getByRole("treeitem", { name: /Lead/ }).click()
    await expect(sheet(page, "Lead").getByRole("heading", { name: "Lead" })).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(company).not.toBeFocused()
    await company.evaluate((el: HTMLElement) => el.focus())
    await expect(company).not.toBeFocused()
    await page.keyboard.press("Escape")
    await company.evaluate((el: HTMLElement) => el.focus())
    await expect(company).toBeFocused()
  })
})
