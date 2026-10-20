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

test("a dropped office shows reconnecting, then a fresh snapshot", async ({ page, request }) => {
  await page.goto("/")
  await expect(connection(page)).toHaveText("live")
  await request.post("/__fixture/set", { data: { view: { company: { name: "Acme Two", ceo: "ngocbh" } } } })
  await request.post("/__fixture/drop", { data: { ms: 1500 } })
  await expect(connection(page)).toHaveText("reconnecting…")
  await expect(page.getByText("Reconnecting to the office…")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Acme Two" })).toBeVisible({ timeout: 15_000 })
  await expect(connection(page)).toHaveText("live")
})

test("a reconnect with an open card in view never asks for the card by id", async ({ page, request }) => {
  // HQ has no GET /api/questions/{id}: re-reading held cards by id would fail every bootstrap and loop.
  await request.post("/__fixture/set", {
    data: { sessions: [session("S1", "ngocbh", "idle")], questions: [card("Q1", "S1", "ngocbh")] },
  })
  await page.goto("/")
  await expect(connection(page)).toHaveText("live")
  await request.post("/__fixture/drop", { data: { ms: 500 } })
  await expect(connection(page)).toHaveText("reconnecting…")
  await expect(connection(page)).toHaveText("live", { timeout: 15_000 })
  const log = await (await request.get("/__fixture/log")).json()
  expect(log.api.filter((p: string) => p.startsWith("/api/questions/"))).toEqual([])
})

test("a missing lazy chunk checks the version and offers a reload instead of a blank page", async ({ page, request }) => {
  await page.route(/\/assets\/company-[^/]*\.js$/, (route) => route.fulfill({ status: 404, body: "not found" }))
  let loads = 0
  page.on("load", () => loads++)
  await page.goto("/")
  await expect(page.getByRole("alert")).toContainText("This screen didn't load.")
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible()
  await expect.poll(async () => (await (await request.get("/__fixture/log")).json()).health).toBeGreaterThanOrEqual(2)
  expect(loads).toBe(1) // the build matches, so no reload: the extra check came from the failed chunk
})

test("session.updated refetches costs at most once every 10 s", async ({ page, request }) => {
  await page.clock.install() // the page's timers, under the test's control; time still flows
  await page.goto("/")
  await expect(connection(page)).toHaveText("live")
  const costReads = async () => (await (await request.get("/__fixture/log")).json()).costs.length
  expect(await costReads()).toBe(1) // the snapshot's
  const updated = { type: "session.updated", data: session("S1", "ngocbh", "busy") }
  await request.post("/__fixture/emit", { data: { event: updated } })
  await request.post("/__fixture/emit", { data: { event: updated } })
  await page.waitForTimeout(500)
  expect(await costReads()).toBe(1) // inside the snapshot's window: one run waits for its end
  await page.clock.fastForward("00:11")
  await expect.poll(costReads).toBe(2)
  await page.waitForTimeout(500)
  expect(await costReads()).toBe(2)
})
