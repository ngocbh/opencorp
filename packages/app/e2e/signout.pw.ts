import { expect, test, type Page } from "@playwright/test"

test.beforeEach(async ({ request }) => void (await request.post("/__fixture/reset")))

const signOutButton = (page: Page) =>
  page.getByRole("navigation", { name: "HQ" }).getByRole("button", { name: /^Sign(ing)? out/ })

/** Signs in with a password, as a person would: the office sets the cookie and the app keeps `hq.session`. */
async function signIn(page: Page) {
  await page.goto("/sign-in")
  await page.getByLabel("Handle").fill("ngocbh")
  await page.getByLabel("Password").fill("correct horse")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  expect(await sessionCookies(page)).toHaveLength(1)
  expect(await storedSession(page)).not.toBeNull()
}

const sessionCookies = async (page: Page) =>
  (await page.context().cookies()).filter((c) => c.name.startsWith("opencorp_hq_") && c.value)
const storedSession = (page: Page) => page.evaluate(() => localStorage.getItem("hq.session"))
const fixtureLog = async (page: Page) => (await page.request.get("/__fixture/log")).json()

test("Sign out ends the session, forgets it here, and lands on sign-in for good", async ({ page }) => {
  await signIn(page)
  const button = signOutButton(page)
  await expect(button).toHaveText("Sign out")
  await button.click()
  await expect(page).toHaveURL("/sign-in")
  await expect(page.getByRole("heading", { name: "Sign in to OpenCorp HQ" })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect((await fixtureLog(page)).logouts).toBe(1)
  expect(await sessionCookies(page)).toEqual([])
  expect(await storedSession(page)).toBeNull()
  // The company was replaced in the history, so Back can't show it.
  await page.goBack()
  expect(new URL(page.url()).pathname).not.toBe("/")
  await expect(page.getByRole("navigation", { name: "HQ" })).toHaveCount(0)
  await page.goto("/")
  await expect(page).toHaveURL("/sign-in")
})

test("Sign out is a focusable button, disabled while the office answers, and sends one request", async ({ page }) => {
  await signIn(page)
  await page.request.post("/__fixture/set", { data: { delay: { "/api/logout": 800 } } })
  const button = signOutButton(page)
  await button.focus()
  await expect(button).toBeFocused()
  await button.dblclick()
  await expect(button).toBeDisabled()
  await expect(button).toHaveText("Signing out…")
  await expect(page).toHaveURL("/sign-in")
  const log = await fixtureLog(page)
  expect(log.api.filter((p: string) => p === "/api/logout")).toHaveLength(1)
  expect(log.logouts).toBe(1)
})

test("Sign out with the office down still signs out here", async ({ page }) => {
  await signIn(page)
  await page.request.post("/__fixture/drop", { data: { ms: 60_000 } }) // every /api request answers 503
  await signOutButton(page).click()
  await expect(page).toHaveURL("/sign-in")
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(await storedSession(page)).toBeNull()
})

test("Sign out with the office unreachable still signs out here", async ({ page }) => {
  await signIn(page)
  await page.route("**/api/logout", (route) => route.abort("connectionrefused"))
  await signOutButton(page).click()
  await expect(page).toHaveURL("/sign-in")
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(await storedSession(page)).toBeNull()
})

test("Sign out with the session already gone (401) still signs out here", async ({ page }) => {
  await signIn(page)
  await page.request.post("/__fixture/set", { data: { signedIn: false } })
  await signOutButton(page).click()
  await expect(page).toHaveURL("/sign-in")
  expect(await storedSession(page)).toBeNull()
  expect((await fixtureLog(page)).logouts).toBe(0)
})

test("Sign out with the office not answering signs out here after a short wait", async ({ page }) => {
  await signIn(page)
  await page.route("**/api/logout", () => {}) // held, never answered
  await signOutButton(page).click()
  await expect(page).toHaveURL("/sign-in", { timeout: 10_000 })
  expect(await storedSession(page)).toBeNull()
})
