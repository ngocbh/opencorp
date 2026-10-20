import { expect, test } from "@playwright/test"
import { acme, session } from "./company"

test.beforeEach(async ({ request, page }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
  await page.goto("/")
  await page.getByRole("radio", { name: "List" }).click()
})

const row = (page: import("@playwright/test").Page, name: RegExp | string) => page.getByRole("treeitem", { name })

test("a tree named after the company; the CEO and level one start open", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Acme" })
  await expect(tree.getByRole("treeitem", { name: /Ngoc/ })).toHaveAttribute("aria-expanded", "true")
  await expect(tree.getByRole("treeitem", { name: /Lead/ })).toHaveAttribute("aria-expanded", "true")
  await expect(row(page, /Lead/)).toHaveAttribute("aria-level", "2")
  await expect(row(page, /Minh/)).toHaveAttribute("aria-level", "3")
  await expect(row(page, /Ann/)).not.toHaveAttribute("aria-expanded") // a leaf
})

test("a row shows status, needs you, cost and +n unpriced", async ({ page }) => {
  await expect(row(page, /Kai/).getByTestId("status")).toHaveAttribute("data-status", "waiting")
  await expect(row(page, /Kai/).getByTestId("needs-you")).toHaveText("1")
  await expect(row(page, /Kai/).getByTestId("cost")).toHaveText("$0.42")
  await expect(row(page, /Minh/).getByTestId("cost")).toHaveText("$0.00 +1 unpriced")
  await expect(row(page, /Minh/).getByTestId("status")).toHaveAttribute("data-status", "busy")
  await expect(row(page, /Ann/).getByTestId("status")).toHaveAttribute("data-status", "away")
  await expect(row(page, /Ann/).getByTestId("needs-you")).toHaveCount(0)
})

test("a branch closes with its chevron, shows totals while closed, and stays closed across reloads", async ({ page }) => {
  await row(page, /Lead/).getByTestId("toggle").click()
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "false")
  await expect(row(page, /Kai/)).toHaveCount(0)
  await expect(row(page, /Lead/)).toContainText("3 people · 1 busy · 2 waiting")
  await expect(row(page, /Lead/)).toContainText("$0.42 +1 unpriced")
  await page.reload()
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "false")
})

test("a leaf shows no branch totals", async ({ page }) => {
  await expect(row(page, /Kai/).getByTestId("cost")).toHaveText("$0.42")
  await expect(row(page, /Ann/)).not.toContainText("person")
  await expect(row(page, /Kai/)).not.toContainText("person")
})

test("arrow keys move, open and close, as the tree pattern says", async ({ page }) => {
  await row(page, /Ngoc/).focus()
  await page.keyboard.press("ArrowDown")
  await expect(row(page, /Ann/)).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(row(page, /Lead/)).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "false")
  await expect(row(page, /Lead/)).toBeFocused() // the row kept its element
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowRight")
  await expect(row(page, /Kai/)).toBeFocused()
  await expect(row(page, /Kai/)).toHaveAttribute("tabindex", "0")
  await page.keyboard.press("ArrowLeft")
  await expect(row(page, /Lead/)).toBeFocused()
  await page.keyboard.press("End")
  await expect(row(page, /Minh/)).toBeFocused()
  await page.keyboard.press("Home")
  await expect(row(page, /Ngoc/)).toBeFocused()
})

test("the toolbar names the company", async ({ page }) => {
  await expect(page.getByRole("main").getByRole("heading", { name: "Acme", level: 2 })).toBeVisible()
})

test("search filters by name, handle or title, keeping the people above a match", async ({ page }) => {
  await page.getByRole("searchbox", { name: "Search people" }).fill("kai")
  await expect(row(page, /Kai/)).toBeVisible()
  await expect(row(page, /Lead/)).toBeVisible()
  await expect(row(page, /Ann/)).toHaveCount(0)
  await page.getByRole("searchbox", { name: "Search people" }).fill("designer")
  await expect(row(page, /Ann/)).toBeVisible()
  await page.getByRole("searchbox", { name: "Search people" }).fill("")
  await expect(row(page, /Minh/)).toBeVisible()
})

test("closing a branch while searching works for that search only, and left then reaches the parent", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search people" })
  await search.fill("kai")
  await row(page, /Lead/).focus()
  await page.keyboard.press("ArrowLeft")
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "false")
  await expect(row(page, /Kai/)).toHaveCount(0)
  await page.keyboard.press("ArrowLeft")
  await expect(row(page, /Ngoc/)).toBeFocused()
  await search.fill("ka") // a new search starts with every kept branch open
  await expect(row(page, /Kai/)).toBeVisible()
  await search.fill("")
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "true")
  await page.reload()
  await page.getByRole("radio", { name: "List" }).click()
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "true") // nothing was saved
})

test("the group filter dims everyone outside the group", async ({ page }) => {
  await page.getByRole("combobox", { name: "Group" }).selectOption("ops")
  await expect(row(page, /Kai/)).toHaveAttribute("data-dimmed", "true")
  await expect(row(page, /Minh/)).toHaveAttribute("data-dimmed", "false")
  await page.getByRole("combobox", { name: "Group" }).selectOption("")
  await expect(row(page, /Kai/)).toHaveAttribute("data-dimmed", "false")
})

test("By team groups people under their teams, muted after their first, with No team last", async ({ page }) => {
  await page.getByText("By team", { exact: true }).click() // the switch's label; its input is visually hidden
  await expect(page.getByRole("switch", { name: "By team" })).toBeChecked()
  await expect(page.getByRole("treeitem", { name: "ENG", exact: true })).toHaveAttribute("aria-level", "1")
  await expect(page.getByRole("treeitem", { name: "OPS", exact: true })).toHaveAttribute("aria-level", "2")
  await expect(page.getByRole("treeitem", { name: "No team", exact: true })).toBeVisible()
  await expect(page.locator('[role=treeitem][data-muted="true"]')).toHaveAttribute("aria-label", "Minh, Engineer")
})

test("the cost window refetches costs and is remembered", async ({ page, request }) => {
  const costs = async () => (await (await request.get("/__fixture/log")).json()).costs as string[]
  await expect(page.getByRole("radio", { name: "Today" })).toHaveAttribute("aria-checked", "true")
  await page.getByRole("radio", { name: "7 days" }).click()
  await expect(page.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true")
  await expect.poll(async () => (await costs()).length).toBe(2)
  const [today, week] = await costs()
  expect(Date.parse(week)).toBeLessThan(Date.parse(today))
  await page.reload()
  await expect(page.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true")
})

test("Chart and List on a desktop; phones always get the list", async ({ page }) => {
  await expect(page.getByRole("radiogroup", { name: "View" }).getByRole("radio")).toHaveText(["Chart", "List"])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByRole("tree", { name: "Acme" })).toBeVisible()
  await expect(page.getByRole("radio", { name: "Chart" })).toHaveCount(0)
})

test("a radio group is one tab stop, and arrow keys move its choice", async ({ page }) => {
  const today = page.getByRole("radio", { name: "Today" })
  await expect(page.getByRole("radiogroup", { name: "Cost window" }).locator("[tabindex='0']")).toHaveCount(1)
  await today.focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("radio", { name: "7 days" })).toBeFocused()
  await expect(page.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true")
  await page.keyboard.press("ArrowLeft")
  await page.keyboard.press("ArrowLeft")
  await expect(page.getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "true")
})

test("unplaced people, the issue banner and the doctor pointer", async ({ page }) => {
  const unplaced = page.getByRole("region", { name: "Unplaced" })
  await expect(unplaced).toContainText("Zoe")
  await expect(unplaced).toContainText("`opencorp doctor` names unknown managers and cycles")
  await expect(page.getByRole("alert").filter({ hasText: "people/bad/person.yaml" })).toContainText("kind: isn't an allowed value")
})

test("a CEO with a manager stays at the top, with a banner", async ({ page, request }) => {
  const people = acme().view.people.map((p) => (p.handle === "ngocbh" ? { ...p, manager: "ann" } : p))
  await request.post("/__fixture/set", { data: { view: { people } } })
  await page.reload()
  await expect(page.getByRole("alert").filter({ hasText: "company.ceo_has_manager" })).toBeVisible()
  await expect(row(page, /Ngoc/)).toHaveAttribute("aria-level", "1")
})

test("no readable company.yaml: a banner, and everyone without a manager at the top", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { view: { company: null } } })
  await page.reload()
  await expect(page.getByRole("alert").filter({ hasText: "company.yaml" })).toBeVisible()
  await expect(page.getByRole("tree", { name: "Company" })).toBeVisible()
})

test("an ask_manager card counts for its work item's assignee, read once", async ({ page, request }) => {
  await expect(row(page, /Lead/).getByTestId("needs-you")).toHaveText("1")
  await request.post("/__fixture/emit", {
    data: { event: { type: "session.updated", data: session("S-lead", "lead", "idle", { updated_at: "2026-10-19T11:00:00.000Z" }) } },
  })
  await page.waitForTimeout(300)
  expect((await (await request.get("/__fixture/log")).json()).workItems).toEqual(["W1"])
})

test("a live status change shows without a reload", async ({ page, request }) => {
  await request.post("/__fixture/emit", {
    data: { event: { type: "session.updated", data: session("S-ann", "ann", "busy", { updated_at: "2026-10-19T12:00:00.000Z" }) } },
  })
  await expect(row(page, /Ann/).getByTestId("status")).toHaveAttribute("data-status", "busy")
})

test("a skeleton shows until the first snapshot", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { delay: { "/api/company": 1000 } } })
  await page.reload()
  await expect(page.locator("[aria-busy=true]")).toBeVisible()
  await expect(page.getByRole("tree", { name: "Acme" })).toBeVisible()
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0)
})
