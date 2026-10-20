import { expect, test } from "@playwright/test"

test.beforeEach(async ({ request, page }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
  await page.goto("/")
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
