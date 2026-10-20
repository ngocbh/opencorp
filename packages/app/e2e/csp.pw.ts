import { expect, test, type Page } from "@playwright/test"

test.beforeEach(async ({ request }) => void (await request.post("/__fixture/reset")))

/**
 * Collects the CSP violations a page reports, from the console and from securitypolicyviolation events. Call the
 * returned function before each navigation and at the end: the events are kept per document.
 */
async function watchCsp(page: Page) {
  const seen: string[] = []
  page.on("console", (m) => void (/content security policy/i.test(m.text()) && seen.push(m.text())))
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      ((window as any).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`),
    ),
  )
  return async () => {
    seen.push(...(await page.evaluate(() => (window as any).__csp?.splice(0) ?? [])))
    return seen
  }
}

test("the built app loads with no CSP violation", async ({ page }) => {
  const violations = await watchCsp(page)
  const response = await page.goto("/")
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'")
  await expect(page.getByRole("heading", { name: "Sign in to OpenCorp HQ" })).toBeVisible()
  // theme.js ran: a missing one is a 404, not a CSP violation.
  expect(await page.locator("html").getAttribute("data-theme")).toMatch(/^(light|dark)$/)
  expect(await violations()).toEqual([])
})

test("the sign-in form, its error and signing in with a password load with no CSP violation", async ({ page }) => {
  const violations = await watchCsp(page)
  await page.goto("/sign-in")
  await page.getByLabel("Handle").fill("ngocbh")
  await page.getByLabel("Password").fill("wrong one")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("alert")).toHaveText("Wrong handle or password.")
  await violations()
  await page.getByLabel("Password").fill("correct horse")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  expect(await violations()).toEqual([])
})

test("the sidebar's Sign out, and the sign-in page it lands on, load with no CSP violation", async ({ page }) => {
  const violations = await watchCsp(page)
  await page.goto("/sign-in")
  await page.getByLabel("Handle").fill("ngocbh")
  await page.getByLabel("Password").fill("correct horse")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  await page.getByRole("navigation", { name: "HQ" }).getByRole("button", { name: "Sign out" }).focus()
  await violations()
  await page.getByRole("navigation", { name: "HQ" }).getByRole("button", { name: "Sign out" }).click()
  await expect(page.getByRole("heading", { name: "Sign in to OpenCorp HQ" })).toBeVisible()
  expect(await violations()).toEqual([])
})

test("pairing, the shell, the reconnecting banner and the blocked page load with no CSP violation", async ({ page, request }) => {
  const violations = await watchCsp(page)
  await page.goto("/pair#nope")
  await expect(page.getByRole("alert")).toBeVisible()
  await violations()
  await request.post("/__fixture/code", { data: { code: "from-ann-1234", issued_by: "ann" } })
  await page.goto("/pair#from-ann-1234")
  await expect(page.getByText("paired by @ann")).toBeVisible()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  await request.post("/__fixture/drop", { data: { ms: 1000 } })
  await expect(page.getByText("Reconnecting to the office…")).toBeVisible()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live", { timeout: 15_000 })
  await violations()
  await request.post("/__fixture/set", { data: { health: { officeApi: "9.9.9+other" } } })
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("doesn't match the office")
  expect(await violations()).toEqual([])
})

test("the list, its toolbar, banners and Kobalte's switch load with no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true, delay: { "/api/company": 500 } } })
  const violations = await watchCsp(page)
  await page.goto("/")
  await expect(page.locator("[aria-busy=true]")).toBeVisible()
  await page.getByRole("radio", { name: "List" }).click()
  await expect(page.getByRole("region", { name: "Unplaced" })).toBeVisible()
  await page.getByRole("combobox", { name: "Group" }).selectOption("ops")
  await page.getByRole("radio", { name: "7 days" }).click()
  await page.getByRole("searchbox", { name: "Search people" }).fill("m")
  await page.getByRole("treeitem", { name: /Lead/ }).getByTestId("toggle").click()
  await page.getByText("By team", { exact: true }).click()
  await expect(page.getByRole("treeitem", { name: "ENG", exact: true })).toBeVisible()
  expect(await violations()).toEqual([])
})

test("the side panel, its live sessions and 'now doing', and the phone sheet load with no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  const violations = await watchCsp(page)
  await page.goto("/")
  await page.getByRole("radio", { name: "List" }).click()
  await page.getByRole("treeitem", { name: /Minh/ }).click()
  await expect(page.getByRole("complementary", { name: "Minh" })).toContainText("now doing: Fix the build")
  await page.getByRole("complementary", { name: "Minh" }).getByRole("button", { name: "Lead" }).click()
  await expect(page.getByRole("complementary", { name: "Lead" })).toContainText("Kai")
  await page.keyboard.press("Escape")
  await violations()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("treeitem", { name: /Ann/ }).click()
  await expect(page.getByRole("dialog", { name: "Ann" })).toBeVisible()
  expect(await violations()).toEqual([])
})

test("the chart, panned, zoomed, pinched, with a branch closed and By team, has no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  const violations = await watchCsp(page)
  await page.goto("/")
  const chart = page.getByRole("figure", { name: "Acme org chart" })
  await expect(chart.getByRole("button", { name: "Ngoc, CEO" })).toBeVisible()
  const box = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 4 })
  await page.mouse.up()
  await page.mouse.wheel(0, -200)
  await page.getByRole("button", { name: "Zoom out" }).click()
  await chart.getByRole("button", { name: "Lead's branch", exact: true }).click()
  await expect(chart.getByRole("button", { name: "Lead, Tech lead" })).toContainText("3 people")
  await chart.getByRole("button", { name: "Ann, Designer" }).click()
  await expect(page.getByRole("complementary", { name: "Ann" })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.getByText("By team", { exact: true }).click()
  await expect(chart.getByRole("group", { name: "ENG", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Fit" }).click()
  expect(await violations()).toEqual([])
})
