import { expect, test, type Page } from "@playwright/test"
import { rid } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const timeline = (page: Page) => page.getByRole("tree", { name: "Timeline" })
const nodeDetail = (page: Page, id: string) => page.getByRole("region", { name: `Node ${id}` })

test("node detail: output, model, evidence, and an error with its traceback folded", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  await timeline(page).getByRole("treeitem", { name: /^iteration chat#2/ }).first().click()
  await timeline(page).getByRole("treeitem", { name: /chat#2\/reply.*succeeded/ }).click()
  const detail = nodeDetail(page, "chat#2/reply")
  await expect(detail).toContainText("Done.")
  await expect(detail).toContainText("gpt-5") // models["chat/reply"]: no kind needed
  await detail.getByText("Prompt", { exact: true }).click()
  await expect(detail.getByText("Fix the build", { exact: true })).toBeVisible()
  await expect(detail).toContainText("workspace.read")
  await page.getByRole("button", { name: "Older nodes" }).click()
  await timeline(page).getByRole("treeitem", { name: /^iteration chat#1/ }).click()
  await timeline(page).getByRole("treeitem", { name: /chat#1\/reply.*failed/ }).click()
  const failed = nodeDetail(page, "chat#1/reply")
  await expect(failed).toContainText("AuthError: 401 key (hidden)")
  await failed.getByText("Traceback", { exact: true }).click()
  await expect(failed.getByText(/…whole…/)).toBeVisible()
})

test("a node whose static path has no model shows none", async ({ page }) => {
  await page.goto(`/runs/${rid(2)}`)
  await timeline(page).getByRole("treeitem", { name: /^debrief/ }).click()
  await expect(nodeDetail(page, "debrief")).toContainText("lessons")
  await expect(nodeDetail(page, "debrief").getByText("Model", { exact: true })).toHaveCount(0)
})

test("an open node says its output comes when it ends, and a side chat keeps no evidence", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  await timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ }).click()
  await expect(nodeDetail(page, "chat#3/ask")).toContainText("running: its output appears when it ends")
  await page.goto(`/runs/${rid(6)}`)
  await timeline(page).getByRole("treeitem", { name: /chat#0\/reply/ }).click()
  await expect(nodeDetail(page, "chat#0/reply")).toContainText("Evidence isn't recorded: this flow isn't learnable.")
})

test("a restarted node says where its partial work is", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  await timeline(page).getByRole("treeitem", { name: /^iteration chat#2/ }).nth(1).click()
  await timeline(page).getByRole("treeitem", { name: /chat#2\/reply.*restarted/ }).click()
  await expect(nodeDetail(page, "chat#2/reply")).toContainText(
    "interrupted: its partial work is only in the session's transcript")
})

test("Enter opens the focused node, and Escape closes it with focus on the row", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  const row = timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ })
  await row.focus()
  await page.keyboard.press("Enter")
  await expect(nodeDetail(page, "chat#3/ask")).toBeVisible()
  await expect(row).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Escape")
  await expect(nodeDetail(page, "chat#3/ask")).toHaveCount(0)
  await expect(row).toBeFocused()
})

test("a node read whose secrets can't be loaded says so and can retry", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(6), fail: "secrets_unavailable" } })
  await page.goto(`/runs/${rid(6)}`)
  await timeline(page).getByRole("treeitem", { name: /chat#0\/reply/ }).click()
  await expect(nodeDetail(page, "chat#0/reply").getByRole("alert")).toHaveText(
    /Couldn't load the secrets to remove; try again\./)
  await request.post("/__fixture/run", { data: { id: rid(6), fail: null } })
  await nodeDetail(page, "chat#0/reply").getByRole("button", { name: "Retry" }).click()
  await expect(nodeDetail(page, "chat#0/reply")).toContainText("Quota.")
})

test("on a phone node detail is a sheet over everything, and Escape returns to the row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/runs/${rid(5)}`)
  const row = timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ })
  await row.click()
  const sheet = page.getByRole("dialog", { name: "Node chat#3/ask" })
  await expect(sheet).toBeVisible()
  expect((await sheet.boundingBox())!.width).toBeLessThanOrEqual(390)
  // Nothing behind it takes focus: the sidebar, or the Timeline.
  const menu = page.getByRole("navigation", { name: "HQ" }).getByRole("button", { name: "Menu" })
  await menu.evaluate((el: HTMLElement) => el.focus())
  await expect(menu).not.toBeFocused()
  await row.evaluate((el: HTMLElement) => el.focus())
  await expect(row).not.toBeFocused()
  await page.keyboard.press("Escape")
  await expect(sheet).toHaveCount(0)
  await expect(row).toBeFocused()
})
