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
