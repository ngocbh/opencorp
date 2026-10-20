import { expect, test } from "@playwright/test"

test.beforeEach(async ({ request }) => void (await request.post("/__fixture/reset")))

test("the link signs in once, drops the code from the URL and the history, and lands on /", async ({ page, request }) => {
  await request.post("/__fixture/code", { data: { code: "good-code-123" } })
  await request.post("/__fixture/set", { data: { delay: { "/api/pair": 1000 } } })
  await page.goto("/pair#good-code-123")
  await expect(page).toHaveURL("/pair") // stripped while the code is still being spent
  await expect(page.getByRole("status")).toHaveText("Signing in…")
  await expect(page).toHaveURL("/")
  const log = await (await request.get("/__fixture/log")).json()
  expect(log.pairs).toEqual([{ code: "good-code-123", label: expect.stringContaining(" on ") }])
  await page.goBack()
  expect(page.url()).not.toContain("good-code-123")
})

test("a used or wrong link says to pair again", async ({ page }) => {
  await page.goto("/pair#nope")
  await expect(page.getByRole("alert")).toHaveText("This link has expired or was already used. Run opencorp pair again.")
  await expect(page.getByRole("alert").locator("code")).toHaveText("opencorp pair")
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(page).toHaveURL("/pair")
})

test("a link without a code says the same", async ({ page }) => {
  await page.goto("/pair")
  await expect(page.getByRole("alert")).toContainText("Run opencorp pair again.")
})

test("without a session the app shows sign-in, and never asks for a password", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveURL("/sign-in")
  await expect(page.getByText("Run opencorp pair on the office machine. HQ never asks for your password here.")).toBeVisible()
  await expect(page.locator("main code").first()).toHaveText("opencorp pair")
  await expect(page.locator("input[type=password]")).toHaveCount(0)
})

test("after pairing, the sidebar names the company and the person, and the connection is live", async ({ page, request }) => {
  await request.post("/__fixture/code", { data: { code: "good-code-123" } })
  await page.goto("/pair#good-code-123")
  await expect(page.getByRole("heading", { name: "Acme" })).toBeVisible()
  await expect(page.getByText("@ngocbh")).toBeVisible()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  await expect(page.getByText(/paired by/)).toHaveCount(0) // paired by themselves
})

test("a browser someone else paired says so", async ({ page, request }) => {
  await request.post("/__fixture/code", { data: { code: "from-ann-1234", issued_by: "ann" } })
  await page.goto("/pair#from-ann-1234")
  await expect(page.getByText("paired by @ann")).toBeVisible()
})

test("a new link opened in the tab that showed a failed one signs in", async ({ page, request }) => {
  await page.goto("/pair#nope")
  await expect(page.getByRole("alert")).toBeVisible()
  await request.post("/__fixture/code", { data: { code: "good-code-123" } })
  await page.goto("/pair#good-code-123") // the same document: only the fragment changes
  await expect(page).toHaveURL("/")
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
})

test("a link that can't reach the office says to pair again", async ({ page }) => {
  await page.route("**/api/pair", (route) => route.abort())
  await page.goto("/pair#good-code-123")
  await expect(page.getByRole("alert")).toContainText("Run opencorp pair again.")
})

test("a browser that refuses storage still signs in", async ({ page, request }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("refused", "SecurityError")
    }
    Storage.prototype.getItem = () => {
      throw new DOMException("refused", "SecurityError")
    }
  })
  await request.post("/__fixture/code", { data: { code: "good-code-123" } })
  await page.goto("/pair#good-code-123")
  await expect(page).toHaveURL("/")
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
})
