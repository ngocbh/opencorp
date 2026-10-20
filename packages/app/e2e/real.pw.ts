import { expect, test, type Page } from "@playwright/test"

// Run with playwright.real.config.ts against a running office, never the fixture server.
const pairUrl = process.env.HQ_PAIR_URL
const handle = process.env.HQ_HANDLE
const password = process.env.HQ_PASSWORD

/** Collects the CSP violations `page` reports, from the console and from securitypolicyviolation events. */
async function watchCsp(page: Page) {
  const seen: string[] = []
  page.on("console", (m) => void (/content security policy/i.test(m.text()) && seen.push(m.text())))
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      ((window as any).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`),
    ),
  )
  return async () => [...seen, ...(await page.evaluate(() => (window as any).__csp?.splice(0) ?? []))]
}

/** The company screen on a desktop: the org chart, with at least one card. */
async function expectChart(page: Page) {
  const chart = page.getByRole("figure", { name: / org chart$/ })
  await expect(chart).toBeVisible()
  await expect(chart.locator("[data-card]").first()).toBeVisible()
}

test("the pair link signs in: the chart on a desktop, the list at phone width, no CSP violation", async ({ page }) => {
  test.skip(!pairUrl, "set HQ_PAIR_URL to a link from `opencorp pair --no-open`")
  const violations = await watchCsp(page)
  const url = new URL(pairUrl!)
  await page.goto(url.pathname + url.hash)
  await expect(page).toHaveURL(/\/$/)
  expect(page.url()).not.toContain("#")
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  await expectChart(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("tree")).toBeVisible()
  await expect(page.getByRole("figure")).toHaveCount(0)
  expect(await violations()).toEqual([])
})

test("the sign-in form signs in with a handle and password", async ({ page }) => {
  test.skip(!pairUrl || !handle || !password, "set HQ_HANDLE and HQ_PASSWORD (and HQ_PAIR_URL for the origin)")
  const violations = await watchCsp(page)
  await page.goto("/")
  await expect(page).toHaveURL(/\/sign-in$/)
  await page.getByLabel("Handle").fill(handle!)
  await page.getByLabel("Password").fill(password!)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/$/)
  await expectChart(page)
  expect(await violations()).toEqual([])
})
