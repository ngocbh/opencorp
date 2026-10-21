import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { session, source } from "./company"
import { crowded, many, rid, run, runLogs } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

/** The list with an empty query: every run, not only the default's open ones from the last 7 days. */
const ALL = "/runs?q="
const DAY = 86_400_000
const table = (page: Page) => page.getByRole("table", { name: "Runs" })
const row = (page: Page, n: number) => table(page).getByRole("row").filter({ hasText: rid(n).slice(-8) })
const tops = (page: Page) => table(page).locator("tr[aria-level='1']")
const box = (page: Page) => page.getByRole("combobox", { name: "Search runs" })
const suggestions = (page: Page) => page.getByRole("listbox", { name: "Suggestions" })
const options = (page: Page) => suggestions(page).getByRole("option")

/** Types `text` as the whole query and searches. */
async function search(page: Page, text: string) {
  await box(page).fill(text)
  await box(page).press("Enter")
}

/** The query of every list read the app made (`?parent=` reads aside), oldest first. */
async function reads(request: APIRequestContext): Promise<URLSearchParams[]> {
  const log = await (await request.get("/__fixture/log")).json()
  return (log.runs as string[]).map((s) => new URLSearchParams(s)).filter((p) => !p.has("parent"))
}

test("one row per top-level run, newest first, with every column", async ({ page }) => {
  await page.goto(ALL)
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
  await page.goto(ALL)
  await expect(row(page, 5).getByRole("link", { name: `replaces …${rid(4).slice(-4)}` })).toHaveAttribute(
    "href", `/runs/${rid(4)}`)
  await expect(row(page, 4).getByRole("link", { name: `replaced by …${rid(5).slice(-4)}` })).toHaveAttribute(
    "href", `/runs/${rid(5)}`)
})

test("with no query the list opens on is:open started:7d, applied before the first read", async ({ page, request }) => {
  const data = runLogs()
  data.runs.push(run(99, { status: "running", ended_at: null, launched_at: new Date(Date.now() - 30 * DAY).toISOString() }))
  await request.post("/__fixture/set", { data: { runs: data } })
  const opened = Date.now()
  await page.goto("/runs")
  await expect(box(page)).toHaveValue("is:open started:7d")
  await expect(row(page, 5)).toBeVisible()
  await expect(row(page, 3)).toBeVisible()
  await expect(tops(page)).toHaveCount(2) // not the closed runs, nor the open one from 30 days ago
  await expect(page).toHaveURL("/runs")
  const [first] = await reads(request)
  expect([...first!.keys()].sort()).toEqual(["limit", "since", "status"])
  expect(first!.get("status")).toBe("running,waiting,idle")
  expect(first!.get("limit")).toBe("50")
  const since = Date.parse(first!.get("since")!)
  expect(since).toBeGreaterThanOrEqual(opened - 7 * DAY - 5_000)
  expect(since).toBeLessThanOrEqual(Date.now() - 7 * DAY)
})

test("every list read carries limit; a cleared box still pages 50 at a time", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: many(120) } })
  await page.goto("/runs")
  await expect(page.getByText("No runs.")).toBeVisible() // all 120 are finished
  await search(page, "")
  await expect(page).toHaveURL("/runs?q=")
  await expect(tops(page)).toHaveCount(50)
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(tops(page)).toHaveCount(100)
  await search(page, "flow:chat")
  await expect(tops(page)).toHaveCount(50)
  // Every read of /api/runs, ?parent= ones included: unfolding uses the children each page brings.
  await tops(page).first().getByRole("button", { name: /Runs under/ }).click()
  await expect(table(page).locator("tr[aria-level='2']")).toHaveCount(1)
  const log = await (await request.get("/__fixture/log")).json()
  const all = (log.runs as string[]).map((s) => new URLSearchParams(s))
  expect(all.length).toBeGreaterThanOrEqual(4)
  for (const p of all) expect(p.get("limit")).toBe("50")
})

test("qualifiers typed in the box filter the list, live in the address, and map onto the read", async ({ page, request }) => {
  await page.goto("/runs")
  await search(page, "flow:side_chat")
  await expect(page).toHaveURL("/runs?q=flow:side_chat")
  await expect(table(page).getByRole("row")).toHaveCount(3) // header, run 5, its side chat (open: it matches)
  await search(page, "person:@lead")
  await expect(row(page, 3)).toBeVisible()
  await expect(row(page, 5)).toHaveCount(0)
  await search(page, "is:closed @minh")
  await expect(row(page, 2)).toBeVisible()
  await expect(tops(page)).toHaveCount(2)
  await search(page, "is:failed started:24h")
  await expect(table(page).getByRole("row")).toHaveCount(2)
  await search(page, "started:2001-01-01..2001-01-31")
  await expect(page.getByText("No runs.")).toBeVisible()
  await search(page, rid(2).slice(-5))
  await expect(row(page, 2)).toBeVisible()
  await expect(tops(page)).toHaveCount(1)
  const [jan, feb] = await page.evaluate(() => [new Date(2001, 0, 1).toISOString(), new Date(2001, 1, 1).toISOString()])
  const sent = (await reads(request)).map((p) => Object.fromEntries(p))
  expect(sent).toContainEqual({ flow: "side_chat", limit: "50" })
  expect(sent).toContainEqual({ person: "lead", limit: "50" })
  expect(sent).toContainEqual({ person: "minh", status: "finished,failed,interrupted", limit: "50" })
  expect(sent).toContainEqual({ since: jan, until: feb, limit: "50" })
  expect(sent).toContainEqual({ q: rid(2).slice(-5), limit: "50" })
})

test("autocomplete by keyboard: qualifiers, then their values, with arrows, Tab, Enter and Esc", async ({ page, request }) => {
  const src = source()
  src.tree.entries.push({ path: "shared/flows/review.yaml", type: "file", size: 10 })
  await request.post("/__fixture/set", { data: { source: { tree: src.tree } } })
  await page.goto("/runs")
  await expect(row(page, 5)).toBeVisible()
  await box(page).focus()
  await expect(suggestions(page)).toBeHidden() // focus alone doesn't open it
  await box(page).press("End")
  await box(page).pressSequentially(" fl")
  await expect(options(page)).toHaveText([/^flow:/])
  await box(page).press("Tab")
  await expect(box(page)).toHaveValue("is:open started:7d flow:")
  // The flows of the runs read so far, and the company's flow files.
  await expect(options(page)).toHaveText([/^chat/, /^review/, /^side_chat/])
  await expect(box(page)).toHaveAttribute("aria-expanded", "true")
  await box(page).press("ArrowDown")
  await box(page).press("ArrowDown")
  const active = page.locator(`#${await box(page).getAttribute("aria-activedescendant")}`)
  await expect(active).toHaveText(/^review/)
  await expect(active).toHaveAttribute("aria-selected", "true")
  await box(page).press("Enter")
  await expect(box(page)).toHaveValue("is:open started:7d flow:review ")
  await expect(suggestions(page)).toBeHidden()
  await expect(page).toHaveURL("/runs") // choosing doesn't search yet
  await box(page).pressSequentially("@k")
  await expect(options(page)).toHaveText(["@kaiKai"])
  await box(page).press("Escape")
  await expect(suggestions(page)).toBeHidden()
  await expect(box(page)).toHaveAttribute("aria-expanded", "false")
  await expect(box(page)).toHaveValue("is:open started:7d flow:review @k")
  await box(page).fill("is:")
  await expect(options(page)).toHaveText([/^open/, /^closed/, /^running/, /^waiting/, /^idle/, /^finished/, /^failed/,
                                          /^interrupted/])
  await box(page).fill("started:")
  await expect(options(page)).toHaveText([/^24h/, /^7d/, /^30d/])
  await box(page).press("ArrowUp") // from none to the last
  await box(page).press("Enter")
  await expect(box(page)).toHaveValue("started:30d ")
  await box(page).press("Enter")
  await expect(page).toHaveURL("/runs?q=started:30d")
})

test("recognised qualifiers are highlighted; unknown ones and a second value are hinted and left out", async ({ page, request }) => {
  await page.goto("/runs")
  const marks = page.getByTestId("search-marks")
  await expect(marks.locator("[data-kind=qualifier]")).toHaveText(["is:open", "started:7d"])
  await box(page).fill("foo:bar flow:chat flow:debrief is:busy")
  await expect(marks.locator("[data-kind=qualifier]")).toHaveText(["flow:chat"])
  await expect(marks.locator("[data-kind=ignored]")).toHaveText(["foo:bar", "flow:debrief", "is:busy"])
  const help = page.locator(`#${await box(page).getAttribute("aria-describedby")}`)
  await expect(help).toHaveText("unknown filter foo: · one flow: at a time · unknown state busy: is: takes open, closed or a state")
  await box(page).press("Enter")
  await expect(page).toHaveURL("/runs?q=foo:bar+flow:chat+flow:debrief+is:busy")
  await expect(row(page, 5)).toBeVisible()
  expect(Object.fromEntries((await reads(request)).at(-1)!)).toEqual({ flow: "chat", limit: "50" })
})

test("Tab with nothing highlighted and no word typed leaves the box, its text as it was", async ({ page }) => {
  await page.goto("/runs")
  await expect(row(page, 5)).toBeVisible()
  await box(page).fill("is:open ")
  await expect(suggestions(page)).toBeVisible() // the qualifiers, offered for the next word
  await box(page).press("Tab")
  await expect(box(page)).toHaveValue("is:open ")
  await expect(box(page)).not.toBeFocused()
})

test("a hint waits until typing pauses, so a half-typed date isn't announced at each key", async ({ page }) => {
  await page.goto("/runs")
  await expect(row(page, 5)).toBeVisible()
  const help = page.locator(`#${await box(page).getAttribute("aria-describedby")}`)
  // Its line is kept while empty, so a hint appearing doesn't move the list down.
  expect((await help.boundingBox())!.height).toBeGreaterThanOrEqual(16)
  await box(page).fill("")
  await box(page).pressSequentially("started:2026-1", { delay: 30 })
  await expect(help).toHaveText("") // not yet: "started:2026-1" is still being typed
  await box(page).pressSequentially("0-13", { delay: 30 })
  await page.waitForTimeout(1_200)
  await expect(help).toHaveText("")
  await box(page).pressSequentially("..x")
  await expect(help).toHaveText("started: takes 24h, 7d, >2026-10-13 or 2026-10-01..2026-10-15")
  await box(page).fill("foo:x")
  await box(page).press("Enter") // at once on Enter
  await expect(help).toHaveText("unknown filter foo:", { timeout: 300 })
})

test("an old ?flow=&person=&status= address becomes the query", async ({ page }) => {
  await page.goto("/runs?person=lead&status=waiting")
  await expect(page).toHaveURL("/runs?q=@lead+is:waiting")
  await expect(box(page)).toHaveValue("@lead is:waiting")
  await expect(row(page, 3)).toBeVisible()
  await expect(tops(page)).toHaveCount(1)
})

test("an exact run id in search opens the run, alone or after qualifiers", async ({ page }) => {
  await page.goto("/runs")
  await box(page).fill(rid(3).toLowerCase())
  await box(page).press("Enter")
  await expect(page).toHaveURL(`/runs/${rid(3)}`)
  await page.goto("/runs")
  await box(page).focus()
  await box(page).press("End")
  await box(page).pressSequentially(` ${rid(4)}`)
  await box(page).press("Enter")
  await expect(page).toHaveURL(`/runs/${rid(4)}`)
})

test("on a phone the box and its suggestions fit, and a tap chooses", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/runs")
  // 16px, so the phone doesn't zoom in when the box is focused.
  expect(await box(page).evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px")
  await box(page).fill("is:")
  await expect(suggestions(page)).toBeVisible()
  for (const el of [box(page), suggestions(page)]) {
    const b = (await el.boundingBox())!
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(390)
  }
  await options(page).filter({ hasText: /^failed/ }).click()
  await expect(box(page)).toHaveValue("is:failed ")
  await expect(box(page)).toBeFocused()
  await box(page).press("Enter")
  await expect(page).toHaveURL("/runs?q=is:failed")
  await expect(row(page, 4)).toBeVisible()
  await expect(tops(page)).toHaveCount(1)
})

test("pages hold 50 top-level runs, each with its children; Load more brings the next", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: many(120) } })
  await page.goto(ALL)
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
  await page.goto(ALL)
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
  await page.goto(ALL)
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
  await page.goto(ALL)
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
  await page.goto(ALL)
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
  await page.goto(ALL)
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
  await page.goto(ALL)
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
  await page.goto(ALL)
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
