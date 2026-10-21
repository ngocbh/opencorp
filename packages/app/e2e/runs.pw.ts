import { expect, test, type Page } from "@playwright/test"
import { session } from "./company"
import { crowded, many, rid, run, runLogs } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const table = (page: Page) => page.getByRole("table", { name: "Runs" })
const row = (page: Page, n: number) => table(page).getByRole("row").filter({ hasText: rid(n).slice(-8) })

test("one row per top-level run, newest first, with every column", async ({ page }) => {
  await page.goto("/runs")
  const rows = table(page).getByRole("row")
  await expect(rows.nth(1)).toContainText(rid(5).slice(-8))
  await expect(row(page, 5)).toContainText("idle")
  await expect(row(page, 5)).toContainText("chat#3/ask")
  await expect(row(page, 4)).toContainText("chat#2/reply")
  await expect(row(page, 3)).toContainText("asking · chat#1/reply")
  await expect(row(page, 2)).toContainText("debrief of a Codex session")
  await expect(row(page, 2)).toContainText("office")
  await expect(row(page, 1)).toContainText("the office stopped")
  await expect(page.getByText("Codex sessions themselves aren't listed")).toBeVisible()
})

test("a run's children fold under it, and the copy button copies the full id", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/runs")
  await expect(row(page, 6)).toHaveCount(0)
  await row(page, 5).getByRole("button", { name: /Runs under/ }).click()
  await expect(row(page, 6)).toContainText("side_chat")
  await expect(row(page, 6)).toContainText("ann")
  await row(page, 5).getByRole("button", { name: "Copy run id" }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(rid(5))
})

test("a fresh run and the run it replaced link to each other", async ({ page }) => {
  await page.goto("/runs")
  await expect(row(page, 5).getByRole("link", { name: `replaces …${rid(4).slice(-4)}` })).toHaveAttribute(
    "href", `/runs/${rid(4)}`)
  await expect(row(page, 4).getByRole("link", { name: `replaced by …${rid(5).slice(-4)}` })).toHaveAttribute(
    "href", `/runs/${rid(5)}`)
})

test("filters and search live in the address; a parent shows when a child matches, opened", async ({ page }) => {
  await page.goto("/runs")
  await page.getByRole("combobox", { name: "Flow" }).selectOption("side_chat")
  await expect(page).toHaveURL("/runs?flow=side_chat")
  await expect(table(page).getByRole("row")).toHaveCount(3) // header, run 5, its side chat (open: it matches)
  await page.getByRole("combobox", { name: "Flow" }).selectOption("")
  await page.getByRole("combobox", { name: "Person" }).selectOption("lead")
  await expect(row(page, 3)).toBeVisible()
  await expect(row(page, 5)).toHaveCount(0)
  await page.goto("/runs?status=failed")
  await expect(table(page).getByRole("row")).toHaveCount(2)
  await page.getByRole("searchbox", { name: "Search runs" }).fill(rid(2).slice(-5))
  await page.getByRole("searchbox", { name: "Search runs" }).press("Enter")
  await expect(page).toHaveURL(/q=/)
})

test("an exact run id in search opens the run", async ({ page }) => {
  await page.goto("/runs")
  await page.getByRole("searchbox", { name: "Search runs" }).fill(rid(3).toLowerCase())
  await page.getByRole("searchbox", { name: "Search runs" }).press("Enter")
  await expect(page).toHaveURL(`/runs/${rid(3)}`)
})

test("pages hold 50 top-level runs, each with its children; Load more brings the next", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: many(120) } })
  await page.goto("/runs")
  const tops = table(page).locator("tr[aria-level='1']")
  await expect(tops).toHaveCount(50)
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(tops).toHaveCount(100)
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(tops).toHaveCount(120)
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0)
})

test("a run with more than 200 children shows the newest 200 and Show all", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: crowded(201) } })
  await page.goto("/runs")
  await table(page).getByRole("button", { name: /Runs under/ }).click()
  await expect(table(page).locator("tr[aria-level='2']")).toHaveCount(200)
  await page.getByRole("button", { name: "Show all 201" }).click()
  await expect(table(page).locator("tr[aria-level='2']")).toHaveCount(201)
})

test("run.updated refetches the list", async ({ page, request }) => {
  await page.goto("/runs")
  await expect(row(page, 3)).toContainText("waiting")
  await request.post("/__fixture/set", { data: { runs: { runs: [], children: {} } } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(3), session_id: "S3", status: "finished", current_nodes: [] } } } })
  await expect(table(page).getByRole("row")).toHaveCount(1) // only the header: the refetch read the emptied office
})

test("on a phone each row stacks into two lines", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/runs")
  const box = (await row(page, 5).boundingBox())!
  expect(box.width).toBeLessThanOrEqual(390)
  await expect(row(page, 5).getByTestId("run-second-line")).toBeVisible()
  // Line 2: the driver, then the participants beside it.
  const driver = (await row(page, 5).getByTestId("run-second-line").boundingBox())!
  const people = (await row(page, 5).getByText("kai, ann").boundingBox())!
  expect(Math.abs(people.y - driver.y)).toBeLessThanOrEqual(2)
  expect(people.x).toBeGreaterThan(driver.x)
  // The columns line up from row to row; a child row is indented as a whole.
  const status = async (n: number) => (await row(page, n).getByText(/^(idle|failed|waiting)$/).boundingBox())!.x
  expect(await status(4)).toBe(await status(5))
  expect(await status(3)).toBe(await status(5))
  await row(page, 5).getByRole("button", { name: /Runs under/ }).click()
  const kid = (await row(page, 6).getByRole("link", { name: rid(6).slice(-8) }).boundingBox())!
  const top = (await row(page, 4).getByRole("link", { name: rid(4).slice(-8) }).boundingBox())!
  expect(kid.x).toBeGreaterThan(top.x)
  expect((await row(page, 6).getByTestId("run-second-line").boundingBox())!.x).toBeGreaterThan(driver.x)
})

test("a live refetch keeps focus where it was", async ({ page, request }) => {
  await page.goto("/runs")
  const toggle = row(page, 5).getByRole("button", { name: /Runs under/ })
  await toggle.focus()
  const data = runLogs()
  data.runs[2] = { ...data.runs[2]!, status: "finished", asking: false, current_nodes: [] }
  await request.post("/__fixture/set", { data: { runs: data } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(3), session_id: "S3", status: "finished", current_nodes: [] } } } })
  await expect(row(page, 3)).toContainText("finished")
  await expect(toggle).toBeFocused()
})

test("a child row says which run it's under, and the toggle names the rows it shows", async ({ page }) => {
  await page.goto("/runs")
  const toggle = row(page, 5).getByRole("button", { name: /Runs under/ })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator(`#${await toggle.getAttribute("aria-controls")}`)).toContainText(rid(6).slice(-8))
  await expect(row(page, 6)).toContainText(`under …${rid(5).slice(-4)}`)
  await expect(row(page, 6)).toHaveAttribute("aria-level", "2")
})

test("copying where the clipboard can't be used says so", async ({ page }) => {
  // As over plain http: no navigator.clipboard.
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }))
  await page.goto("/runs")
  await row(page, 5).getByRole("button", { name: "Copy run id" }).click()
  await expect(row(page, 5).getByRole("status")).toHaveText("Couldn't copy")
})

test("a copied id is announced", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/runs")
  await row(page, 5).getByRole("button", { name: "Copy run id" }).click()
  await expect(row(page, 5).getByRole("status")).toHaveText("Copied")
})

test("session.updated refetches the list", async ({ page, request }) => {
  await page.goto("/runs")
  await expect(row(page, 3)).toBeVisible()
  await request.post("/__fixture/set", { data: { runs: { runs: [], children: {} } } })
  await request.post("/__fixture/emit", { data: { event: { type: "session.updated", data: session("S-kai", "kai", "busy") } } })
  await expect(table(page).getByRole("row")).toHaveCount(1)
})

test("the list is read again when the office is back", async ({ page, request }) => {
  await page.goto("/runs")
  await expect(row(page, 3)).toBeVisible()
  await request.post("/__fixture/set", { data: { runs: { runs: [], children: {} } } })
  await request.post("/__fixture/drop", { data: { ms: 1000 } })
  await expect(table(page).getByRole("row")).toHaveCount(1, { timeout: 15_000 })
})

test("the list opened while the office reconnects reads again once it's back", async ({ page, request }) => {
  await page.goto(`/runs/${rid(5)}`)
  await expect(page.getByRole("region", { name: "Run" })).toBeVisible()
  // The reconnect's snapshot waits, so the list opens while the office is "connecting", and its first read fails.
  await request.post("/__fixture/set", { data: { delay: { "/api/company": 3000 }, fail: { "/api/runs": 500 } } })
  await request.post("/__fixture/drop", { data: { ms: 0 } })
  await expect(page.getByText("Reconnecting to the office…")).toBeVisible()
  await page.getByRole("navigation", { name: "HQ" }).getByRole("link", { name: "Run Logs" }).click()
  await expect(page.getByRole("alert")).toContainText("Couldn't read the runs")
  await request.post("/__fixture/set", { data: { fail: {} } })
  await expect(row(page, 3)).toBeVisible({ timeout: 10_000 })
})

test("a failed read says why, and Retry reads again", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { fail: { "/api/runs": 500 } } })
  await page.goto("/runs")
  await expect(page.getByRole("alert")).toContainText("Couldn't read the runs")
  // The page also reads again once the office is first online (throttled to a second); let that read fail too.
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  await page.waitForTimeout(1500)
  await expect(page.getByRole("alert")).toContainText("Couldn't read the runs")
  await request.post("/__fixture/set", { data: { fail: {} } })
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(row(page, 5)).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("a filtered fold shows the matching children until Show the rest", async ({ page, request }) => {
  const kids = [
    run(9, { flow: "side_chat", driver: "ann", parent_run_id: rid(7) }),
    run(8, { flow: "side_chat", driver: "lead", participants: ["kai"], parent_run_id: rid(7) }),
  ]
  await request.post("/__fixture/set", {
    data: { runs: { runs: [run(7, { children: kids, children_total: 2 })], children: { [rid(7)]: kids } } },
  })
  await page.goto("/runs?person=ann")
  await expect(row(page, 9)).toBeVisible()
  await expect(row(page, 8)).toHaveCount(0)
  await page.getByRole("button", { name: "Show the rest" }).click()
  await expect(row(page, 8)).toBeVisible()
  await expect(page.getByRole("button", { name: "Show the rest" })).toHaveCount(0)
})

test("Show all's children are read again on a refetch, and a failed read says so", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: crowded(201) } })
  await page.goto("/runs")
  await table(page).getByRole("button", { name: /Runs under/ }).click()
  await request.post("/__fixture/set", { data: { fail: { "/api/runs": 500 } } })
  await page.getByRole("button", { name: "Show all 201" }).click()
  await expect(table(page).getByRole("alert")).toContainText("Couldn't read the runs under")
  await request.post("/__fixture/set", { data: { fail: {} } })
  await page.getByRole("button", { name: "Show all 201" }).click()
  await expect(table(page).locator("tr[aria-level='2']")).toHaveCount(201)
  await expect(table(page).getByRole("alert")).toHaveCount(0)
  await request.post("/__fixture/set", { data: { runs: crowded(202) } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(4000), session_id: "S4000", status: "finished", current_nodes: [] } } } })
  await expect(table(page).locator("tr[aria-level='2']")).toHaveCount(202)
})

test("a live refetch keeps focus on a child Show all brought", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: crowded(201) } })
  await page.goto("/runs")
  await table(page).getByRole("button", { name: /Runs under/ }).click()
  await page.getByRole("button", { name: "Show all 201" }).click()
  const link = row(page, 5001).getByRole("link", { name: rid(5001).slice(-8) }) // only in Show all's read
  await link.focus()
  const data = crowded(201)
  const kids = data.children[rid(4000)]!
  kids[200] = { ...kids[200]!, status: "failed" }
  await request.post("/__fixture/set", { data: { runs: data } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(5001), session_id: "S5001", parent_run_id: rid(4000), status: "failed", current_nodes: [] } } } })
  await expect(row(page, 5001)).toContainText("failed")
  await expect(link).toBeFocused()
})

test("Load more can be pressed while a live re-read runs", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: many(120) } })
  await page.goto("/runs")
  const tops = table(page).locator("tr[aria-level='1']")
  await expect(tops).toHaveCount(50)
  await page.waitForTimeout(1500) // past the read once the office is first online
  // `api` logs a request as it arrives, before its delay.
  const reads = async () =>
    ((await (await request.get("/__fixture/log")).json()).api as string[]).filter((p) => p === "/api/runs").length
  const before = await reads()
  await request.post("/__fixture/set", { data: { delay: { "/api/runs": 1500 } } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(1240), session_id: "S1240", status: "finished", current_nodes: [] } } } })
  await expect.poll(reads).toBeGreaterThan(before) // the re-read is on its way
  // Within the re-read's 1.5 s, not once it's done.
  await expect(page.getByRole("button", { name: "Load more" })).toBeEnabled({ timeout: 500 })
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(tops).toHaveCount(100, { timeout: 10_000 })
})

test("a refetch during Load more keeps the page it brings", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: many(120) } })
  await page.goto("/runs")
  const tops = table(page).locator("tr[aria-level='1']")
  await expect(tops).toHaveCount(50)
  await request.post("/__fixture/set", { data: { delay: { "/api/runs": 1000 } } })
  await page.getByRole("button", { name: "Load more" }).click()
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(1240), session_id: "S1240", status: "finished", current_nodes: [] } } } })
  await expect(tops).toHaveCount(100, { timeout: 10_000 })
  await page.waitForTimeout(3000) // the refetch's answer, after Load more's
  await expect(tops).toHaveCount(100)
})
