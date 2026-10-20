import { expect, test, type Page } from "@playwright/test"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const nav = (page: Page) => page.getByRole("navigation", { name: "HQ" })
const org = (page: Page) => nav(page).getByRole("link", { name: "Org" })

test("/ goes to /org, replacing itself in the history, and Org is the current page", async ({ page }) => {
  await page.goto("/org")
  await expect(org(page)).toHaveAttribute("aria-current", "page")
  const entries = await page.evaluate(() => history.length)
  await page.goto("/")
  await expect(page).toHaveURL("/org")
  await expect(page.getByRole("tree").or(page.getByRole("figure"))).toBeVisible()
  expect(await page.evaluate(() => history.length)).toBe(entries + 1)
  await expect(org(page)).toHaveAttribute("aria-current", "page")
})

test("an address with no page says so inside the shell, with no item current", async ({ page }) => {
  await page.goto("/nowhere")
  await expect(page.getByRole("main")).toContainText("There's no page here.")
  await expect(nav(page).locator("[aria-current]")).toHaveCount(0)
  await org(page).click()
  await expect(page).toHaveURL("/org")
  await expect(org(page)).toHaveAttribute("aria-current", "page")
})

/** The pages HQ doesn't have yet, each with what it says about itself. */
const SOON: [string, RegExp][] = [
  ["Inbox", /needs you/],
  ["Issues", /#238/],
  ["Goals", /#239/],
  ["Routines", /scheduled SOPs/i],
  ["SOPs", /Yian flows/],
  ["Connections", /model providers/i],
  ["Activity", /audit/i],
]
const soon = (page: Page, name: string) => nav(page).getByRole("link", { name: `${name} soon`, exact: true })

test("the sidebar: the company and its connection, Inbox, then Work and Company, with only Org enabled", async ({ page }) => {
  await page.goto("/org")
  await expect(nav(page).getByRole("heading", { name: "Acme", level: 1 })).toBeVisible()
  await expect(nav(page).getByRole("status", { name: "Connection" })).toHaveText("live")
  await expect(nav(page)).toMatchAriaSnapshot(`
    - list:
      - listitem:
        - link "Inbox soon" [disabled]
    - group "Work":
      - heading "Work" [level=2]
      - list:
        - listitem:
          - link "Issues soon" [disabled]
        - listitem:
          - link "Goals soon" [disabled]
        - listitem:
          - link "Routines soon" [disabled]
    - group "Company":
      - heading "Company" [level=2]
      - list:
        - listitem:
          - link "Org"
        - listitem:
          - link "SOPs soon" [disabled]
        - listitem:
          - link "Connections soon" [disabled]
        - listitem:
          - link "Activity soon" [disabled]
  `)
  await expect(soon(page, "Inbox")).toBeVisible()
  // Org is the one page there is: the only link with an address, and the only one enabled.
  await expect(nav(page).locator("a[href]")).toHaveCount(1)
  await expect(nav(page).locator("a[href]")).toHaveAttribute("href", "/org")
  await expect(nav(page).getByRole("link", { disabled: false })).toHaveText(["Org"])
  await expect(nav(page).getByText(/^@ngocbh$/)).toBeVisible()
  await expect(nav(page).getByRole("button", { name: "Sign out" })).toBeVisible()
})

test("a soon item is announced unavailable, says what it will be, and can't take focus", async ({ page }) => {
  await page.goto("/org")
  for (const [name, says] of SOON) {
    const item = soon(page, name)
    await expect(item).toHaveAttribute("aria-disabled", "true")
    await expect(item).toBeDisabled()
    await expect(item).not.toHaveAttribute("href")
    await expect(item).not.toHaveAttribute("aria-current")
    await expect(item).toHaveAccessibleDescription(says)
    await expect(item).toHaveAttribute("title", says)
    await expect(item.getByText("soon", { exact: true })).toBeVisible()
    await item.evaluate((el: HTMLElement) => el.focus())
    await expect(item).not.toBeFocused()
    // Clicking it anyway goes nowhere.
    await item.click({ force: true })
    await expect(page).toHaveURL("/org")
  }
  // Tab goes from Org straight to Sign out, past the soon items.
  await org(page).focus()
  await page.keyboard.press("Tab")
  await expect(nav(page).getByRole("button", { name: "Sign out" })).toBeFocused()
})

test("the connection status follows the office", async ({ page, request }) => {
  await page.goto("/org")
  const connection = nav(page).getByRole("status", { name: "Connection" })
  await expect(connection).toHaveText("live")
  await request.post("/__fixture/drop", { data: { ms: 1000 } })
  await expect(connection).toHaveText("reconnecting…")
  await expect(connection).toHaveText("live", { timeout: 15_000 })
})
