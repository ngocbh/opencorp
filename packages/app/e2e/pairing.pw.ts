import { expect, test } from "@playwright/test"

test.beforeEach(async ({ request }) => void (await request.post("/__fixture/reset")))

test("the link signs in once, drops the code from the URL and the history, and lands on /", async ({ page, request }) => {
  await request.post("/__fixture/code", { data: { code: "good-code-123" } })
  await page.goto("/pair#good-code-123")
  await expect(page).toHaveURL("/")
  const log = await (await request.get("/__fixture/log")).json()
  expect(log.pairs).toEqual([{ code: "good-code-123", label: expect.stringContaining(" on ") }])
  await page.goBack()
  expect(page.url()).not.toContain("good-code-123")
})

test("a used or wrong link says to pair again", async ({ page }) => {
  await page.goto("/pair#nope")
  await expect(page.getByRole("alert")).toHaveText("This link has expired or was already used. Run `opencorp pair` again.")
})

test("a link without a code says the same", async ({ page }) => {
  await page.goto("/pair")
  await expect(page.getByRole("alert")).toContainText("Run `opencorp pair` again.")
})
