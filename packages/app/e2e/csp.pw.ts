import { expect, test } from "@playwright/test"

test("the built app loads with no CSP violation", async ({ page }) => {
  const violations: string[] = []
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) violations.push(m.text())
  })
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      ((window as any).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`),
    ),
  )
  const response = await page.goto("/")
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'")
  await expect(page.getByText("OpenCorp HQ")).toBeVisible()
  expect([...violations, ...(await page.evaluate(() => (window as any).__csp ?? []))]).toEqual([])
})
