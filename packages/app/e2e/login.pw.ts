import { expect, test, type Page } from "@playwright/test"

test.beforeEach(async ({ request }) => void (await request.post("/__fixture/reset")))

const PASSWORD = "correct horse"

/** Every URL `page`'s main frame visits from now on. */
function visited(page: Page) {
  const urls: string[] = []
  page.on("framenavigated", (f) => void (f === page.mainFrame() && urls.push(f.url())))
  return urls
}

/** Every console message `page` logs from now on. */
function consoleOf(page: Page) {
  const lines: string[] = []
  page.on("console", (m) => void lines.push(m.text()))
  return lines
}

async function signIn(page: Page, handle: string, password: string) {
  await page.getByLabel("Handle").fill(handle)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
}

test("sign-in shows the form first, with its autocomplete hints, and opencorp pair below as the other way", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveURL("/sign-in")
  const handle = page.getByLabel("Handle")
  const password = page.getByLabel("Password")
  await expect(handle).toHaveAttribute("autocomplete", "username")
  await expect(password).toHaveAttribute("type", "password")
  await expect(password).toHaveAttribute("autocomplete", "current-password")
  const pair = page.getByText("Or run opencorp pair on the office machine and open the link it prints.")
  await expect(pair).toBeVisible()
  await expect(pair.locator("code")).toHaveText("opencorp pair")
  await expect(page.getByText("Over SSH, opencorp pair prints the ssh -N -L command to run first.")).toBeVisible()
  const form = await page.locator("form").boundingBox()
  const below = await pair.boundingBox()
  expect(below!.y).toBeGreaterThan(form!.y + form!.height - 1)
})

test("the right handle and password land on / signed in; the handle is cleaned and the password never leaves the form", async ({ page, request }) => {
  const urls = visited(page)
  const logged = consoleOf(page)
  await page.goto("/sign-in")
  await page.getByLabel("Handle").fill("  @NgocBH ")
  await page.getByLabel("Password").fill(PASSWORD)
  await page.getByLabel("Password").press("Enter")
  await expect(page).toHaveURL("/")
  await expect(page.getByText("@ngocbh")).toBeVisible()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  await expect(page.getByText(/paired by/)).toHaveCount(0) // signed in as themselves
  const log = await (await request.get("/__fixture/log")).json()
  expect(log.logins).toEqual([{ handle: "ngocbh", label: expect.stringContaining(" on ") }])
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  expect(JSON.parse(stored)["hq.session"]).toBeDefined()
  expect(stored).not.toContain(PASSWORD)
  for (const url of [...urls, page.url()]) expect(decodeURIComponent(url)).not.toContain("correct")
  for (const line of logged) expect(line).not.toContain(PASSWORD)
})

test("a wrong password says so in an alert the fields point to, clears the password and keeps the handle", async ({ page }) => {
  const logged = consoleOf(page)
  await page.goto("/sign-in")
  await expect(page.getByLabel("Password")).not.toHaveAttribute("aria-invalid", "true")
  await signIn(page, "ngocbh", "wrong one")
  const alert = page.getByRole("alert")
  await expect(alert).toHaveText("Wrong handle or password.")
  const id = await alert.getAttribute("id")
  expect(id).toBeTruthy()
  await expect(page.getByLabel("Password")).toHaveAttribute("aria-describedby", id!)
  await expect(page.getByLabel("Handle")).toHaveAttribute("aria-describedby", id!)
  await expect(page.getByLabel("Password")).toHaveAttribute("aria-invalid", "true")
  await expect(page.getByLabel("Password")).toHaveAccessibleDescription("Wrong handle or password.")
  await expect(page.getByLabel("Password")).toHaveValue("")
  await expect(page.getByLabel("Password")).toBeFocused()
  await expect(page.getByLabel("Handle")).toHaveValue("ngocbh")
  await expect(page).toHaveURL("/sign-in")
  for (const line of logged) expect(line).not.toContain("wrong one")
  // A handle that isn't one, or an agent's, says exactly the same.
  for (const handle of ["nobody", "minh"]) {
    await signIn(page, handle, PASSWORD)
    await expect(page.getByRole("alert")).toHaveText("Wrong handle or password.")
    await expect(page.getByLabel("Password")).toHaveValue("")
  }
})

test("a handle that can't be one says the same without asking the office", async ({ page, request }) => {
  await page.goto("/sign-in")
  for (const handle of ["Not a handle", "@", "-ann"]) {
    await signIn(page, handle, PASSWORD)
    await expect(page.getByRole("alert")).toHaveText("Wrong handle or password.")
    await expect(page.getByLabel("Password")).toHaveValue("")
  }
  const log = await (await request.get("/__fixture/log")).json()
  expect(log.logins).toEqual([])
})

test("an office that can't take a password yet says to pair instead", async ({ page }) => {
  // What an office without /api/login answers: the 401 it gives any request without a session.
  await page.route("**/api/login", (route) =>
    route.fulfill({ status: 401, json: { error: "sign_in_required", message: "Sign in: run `opencorp pair`." } }),
  )
  await page.goto("/sign-in")
  await signIn(page, "ngocbh", PASSWORD)
  await expect(page.getByRole("alert")).toHaveText("This office can't take a password yet; run opencorp pair.")
  await expect(page.getByRole("alert").locator("code")).toHaveText("opencorp pair")
  await expect(page).toHaveURL("/sign-in")
})

test("too many tries says how long to wait, or to pair", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { login: { retryAfter: 600, busy: false } } })
  await page.goto("/sign-in")
  await signIn(page, "ngocbh", PASSWORD)
  await expect(page.getByRole("alert")).toHaveText("Too many tries; wait 10 minutes, or run opencorp pair.")
  await expect(page.getByRole("alert").locator("code")).toHaveText("opencorp pair")
  await expect(page.getByLabel("Password")).toHaveValue("")
})

test("a busy office says to try again, and the next try signs in", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { login: { retryAfter: null, busy: true } } })
  await page.goto("/sign-in")
  await signIn(page, "ngocbh", PASSWORD)
  await expect(page.getByRole("alert")).toHaveText("The office is busy; try again.")
  await request.post("/__fixture/set", { data: { login: { retryAfter: null, busy: false } } })
  await page.getByLabel("Password").fill(PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL("/")
})

test("an office it can't reach says what went wrong", async ({ page }) => {
  await page.route("**/api/login", (route) => route.abort())
  await page.goto("/sign-in")
  await signIn(page, "ngocbh", PASSWORD)
  await expect(page.getByRole("alert")).toContainText("Couldn't sign in: can't reach the office")
  await expect(page.getByLabel("Password")).toHaveValue("")
})

test("while the office checks, the form is busy and read-only and keeps focus, and a double submit sends one try", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { delay: { "/api/login": 1000 } } })
  await page.goto("/sign-in")
  await page.getByLabel("Handle").fill("ngocbh")
  await page.getByLabel("Password").fill(PASSWORD)
  await page.getByLabel("Password").press("Enter")
  await page.getByLabel("Password").press("Enter")
  await expect(page.locator("form")).toHaveAttribute("aria-busy", "true")
  await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled()
  await expect(page.getByLabel("Handle")).not.toBeEditable()
  await expect(page.getByLabel("Password")).not.toBeEditable()
  await expect(page.getByLabel("Password")).toBeFocused()
  await expect(page.getByLabel("Password")).toHaveValue(PASSWORD) // read-only, not wiped
  await expect(page).toHaveURL("/")
  let log = await (await request.get("/__fixture/log")).json()
  expect(log.logins.length).toBe(1)
  // A double click on the button too.
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { delay: { "/api/login": 1000 } } })
  await page.goto("/sign-in")
  await page.getByLabel("Handle").fill("ngocbh")
  await page.getByLabel("Password").fill(PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click({ clickCount: 2 })
  await expect(page).toHaveURL("/")
  log = await (await request.get("/__fixture/log")).json()
  expect(log.logins.length).toBe(1)
})
