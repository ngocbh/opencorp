import { expect, test } from "@playwright/test"
import { card, session } from "./company"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const connection = (page: import("@playwright/test").Page) => page.getByRole("status", { name: "Connection" })

test("a session revoked while the tab is open (devices remove-browser, logout, a password change) goes to sign-in", async ({ page, request }) => {
  await page.goto("/")
  await expect(connection(page)).toHaveText("live")
  await request.post("/__fixture/set", { data: { signedIn: false } })
  await request.post("/__fixture/drop", { data: { ms: 0 } }) // the office ends the revoked session's stream
  await expect(page).toHaveURL("/sign-in")
})

test("an app built for another office says so and doesn't reload", async ({ page, request }) => {
  let loads = 0
  page.on("load", () => loads++)
  await request.post("/__fixture/set", { data: { health: { officeApi: "9.9.9+other" } } })
  await page.goto("/")
  await expect(page.getByText("The web app doesn't match the office. Run `bun run build`, or `opencorp restart`.")).toBeVisible()
  expect(loads).toBe(1)
})

test("no build shows the not-built page", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { health: { app: null } } })
  await page.goto("/")
  await expect(page.getByText("The web app isn't built: run `bun run build` in the checkout.")).toBeVisible()
})

test("a rebuilt dist reloads the page once", async ({ page, request }) => {
  let loads = 0
  page.on("load", () => loads++)
  await request.post("/__fixture/set", { data: { health: { build: "a-newer-build" } } })
  await page.goto("/")
  await expect(connection(page)).toHaveText("live")
  await page.waitForTimeout(1000)
  expect(loads).toBe(2) // the first load and one reload; the sessionStorage guard stops a loop
})
