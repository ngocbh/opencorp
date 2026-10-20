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
  await expect(page.getByRole("main").getByRole("heading", { name: "There's no page here.", level: 2 })).toBeVisible()
  await expect(nav(page).locator("[aria-current]")).toHaveCount(0)
  await page.getByRole("main").getByRole("link", { name: "Org" }).click()
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
  // The sidebar stays on screen however long the company view is: who is signed in and Sign out are in view.
  await expect(page.getByRole("figure", { name: "Acme org chart" })).toBeVisible()
  await expect(nav(page).getByText(/^@ngocbh$/)).toBeInViewport()
  await expect(nav(page).getByRole("button", { name: "Sign out" })).toBeInViewport()
  await page.mouse.wheel(0, 2000)
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0)
  await expect(nav(page).getByRole("heading", { name: "Acme", level: 1 })).toBeInViewport()
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
    // Read once, as the description: the text itself is hidden.
    await expect(nav(page).getByText(says)).toBeHidden()
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

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  const menu = (page: Page) => nav(page).getByRole("button", { name: "Menu" })

  test("the sidebar folds into a top bar, and the company view gets the full width", async ({ page }) => {
    await page.goto("/org")
    await expect(nav(page).getByRole("heading", { name: "Acme", level: 1 })).toBeVisible()
    await expect(nav(page).getByRole("status", { name: "Connection" })).toHaveText("live")
    await expect(menu(page)).toHaveAttribute("aria-expanded", "false")
    await expect(org(page)).toBeHidden()
    const bar = (await nav(page).boundingBox())!
    expect(bar.width).toBe(390)
    expect(bar.height).toBeLessThanOrEqual(56)
    const main = (await page.getByRole("main").boundingBox())!
    expect([main.x, main.width]).toEqual([0, 390])
    expect(main.y).toBeGreaterThanOrEqual(bar.height)
    await expect(page.getByRole("tree", { name: "Acme" })).toBeVisible()
  })

  test("the top bar stays on screen as the page scrolls, and the open menu holds the page still", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 480 })
    await page.goto("/org")
    await expect(page.getByRole("tree", { name: "Acme" })).toBeVisible()
    await page.mouse.move(200, 300)
    await page.mouse.wheel(0, 400)
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0)
    await expect(menu(page)).toBeInViewport()
    expect((await nav(page).boundingBox())!.y).toBe(0)
    await menu(page).click()
    await expect(org(page)).toBeInViewport()
    const before = await page.evaluate(() => scrollY)
    await page.mouse.move(350, 300) // over the backdrop
    await page.mouse.wheel(0, 400)
    await page.mouse.move(100, 300) // over the drawer
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => scrollY)).toBe(before)
    await page.keyboard.press("Escape")
    await page.mouse.move(200, 300)
    await page.mouse.wheel(0, -400)
    await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(before)
  })

  test("Menu opens the pages by keyboard; Escape closes it and focus goes back to Menu", async ({ page }) => {
    await page.goto("/org")
    await menu(page).focus()
    await page.keyboard.press("Enter")
    await expect(menu(page)).toHaveAttribute("aria-expanded", "true")
    const drawer = page.locator(`#${await menu(page).getAttribute("aria-controls")}`)
    await expect(drawer).toBeVisible()
    await expect(soon(page, "Issues")).toBeVisible()
    await expect(soon(page, "Issues")).toBeDisabled()
    await expect(org(page)).toHaveAttribute("aria-current", "page")
    // The company view behind the open menu can't take focus.
    const row = page.getByRole("treeitem", { name: /Lead/ })
    await row.evaluate((el: HTMLElement) => el.focus())
    await expect(row).not.toBeFocused()
    await menu(page).focus()
    await page.keyboard.press("Tab")
    await expect(org(page)).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(nav(page).getByRole("button", { name: "Sign out" })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(menu(page)).toHaveAttribute("aria-expanded", "false")
    await expect(drawer).toBeHidden()
    await expect(menu(page)).toBeFocused()
    await row.evaluate((el: HTMLElement) => el.focus())
    await expect(row).toBeFocused()
  })

  test("choosing a page or tapping outside closes the menu", async ({ page }) => {
    await page.goto("/nowhere")
    await menu(page).click()
    await org(page).click()
    await expect(page).toHaveURL("/org")
    await expect(menu(page)).toHaveAttribute("aria-expanded", "false")
    await menu(page).click()
    await org(page).click() // already there: the menu closes all the same
    await expect(menu(page)).toHaveAttribute("aria-expanded", "false")
    await menu(page).click()
    await page.mouse.click(380, 400) // the backdrop, right of the drawer
    await expect(menu(page)).toHaveAttribute("aria-expanded", "false")
  })

  test("Sign out works from the menu", async ({ page }) => {
    await page.goto("/org")
    await menu(page).click()
    await nav(page).getByRole("button", { name: "Sign out" }).click()
    await expect(page).toHaveURL("/sign-in")
    expect((await (await page.request.get("/__fixture/log")).json()).logouts).toBe(1)
  })

  test("a menu left open closes when the window grows to a desktop's", async ({ page }) => {
    await page.goto("/org")
    await menu(page).click()
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(menu(page)).toBeHidden()
    await expect(org(page)).toBeVisible()
    await page.getByRole("radio", { name: "List" }).click() // the main area takes input again
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(menu(page)).toHaveAttribute("aria-expanded", "false")
    await expect(org(page)).toBeHidden()
  })
})
