import { expect, test, type Page } from "@playwright/test"
import { crowded, node, rid } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const header = (page: Page) => page.getByRole("region", { name: "Run" })
const timeline = (page: Page) => page.getByRole("tree", { name: "Timeline" })
const logStatus = (page: Page) => page.getByRole("status", { name: "Log" })

test("the header says what ran, who drove it, when, and where the session is", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto(`/runs/${rid(5)}`)
  for (const text of ["chat", "shared/flows/chat.yaml", "b".repeat(12), "a".repeat(12), "idle · chat#3/ask", "@ngocbh", "kai, ann",
                      "1,200 in · 300 out · $0.0123", "Every signed-in human can read every run log"])
    await expect(header(page)).toContainText(text)
  await expect(header(page).getByRole("link", { name: `replaces …${rid(4).slice(-4)}` })).toHaveAttribute("href", `/runs/${rid(4)}`)
  await expect(header(page).getByRole("link", { name: rid(6).slice(-8) })).toBeVisible() // a child
  await header(page).getByRole("button", { name: "Copy session id" }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("S5")
  await expect(page.getByRole("navigation", { name: "HQ" }).getByRole("link", { name: "Run Logs" })).toHaveClass(/active/)
})

test("the status doesn't repeat its word, or how long a finished run took", async ({ page, request }) => {
  const status = () => header(page).getByRole("definition").first()
  await request.post("/__fixture/run", { data: { id: rid(3), detail: { run: { status: "finished", ended_at:
    "2026-10-20T10:09:00.000Z" } } } })
  await page.goto(`/runs/${rid(3)}`)
  await expect(status()).toHaveText("finished")
  await expect(header(page)).toContainText("took 6m 0s")
  await request.post("/__fixture/run", { data: { id: rid(4), detail: { run: { failed_node: null, reason: null } } } })
  await page.goto(`/runs/${rid(4)}`)
  await expect(status()).toHaveText("failed")
  await request.post("/__fixture/run", { data: { id: rid(1), detail: { run: { reason: null } } } })
  await page.goto(`/runs/${rid(1)}`)
  await expect(status()).toHaveText("interrupted")
})

test("a debrief says its usage isn't recorded", async ({ page }) => {
  await page.goto(`/runs/${rid(2)}`)
  await expect(header(page)).toContainText("usage not recorded")
  await expect(header(page)).toContainText("debrief of a Codex session")
})

test("the Timeline: newest first, the latest iteration open, older ones folded, older pages on unfold", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  const items = timeline(page).getByRole("treeitem")
  await expect(items.first()).toContainText("chat#3")
  await expect(timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ })).toContainText("open")
  const turn2 = timeline(page).getByRole("treeitem", { name: /^iteration chat#2/ })
  await expect(turn2).toHaveCount(2) // split by the resume divider
  await expect(turn2.first()).toHaveAttribute("aria-expanded", "false")
  for (const group of await turn2.all()) await group.click()
  await expect(timeline(page).getByText("resumed; retried reply")).toBeVisible()
  await expect(timeline(page).getByRole("treeitem", { name: /chat#2\/reply.*restarted/ })).toBeVisible()
  await expect(timeline(page).getByRole("treeitem", { name: /chat#2\/route.*routed → reply/ })).toBeVisible()
  await expect(timeline(page).getByRole("treeitem", { name: /^chat expanded/ })).toHaveCount(0) // on the older page
  await page.getByRole("button", { name: "Older nodes" }).click()
  await expect(timeline(page).getByRole("treeitem", { name: /^chat expanded/ })).toBeVisible()
  await timeline(page).getByRole("treeitem", { name: /^iteration chat#1/ }).click()
  await expect(timeline(page).getByRole("treeitem", { name: /chat#1\/reply.*failed/ })).toContainText(
    "AuthError: 401 key (hidden)")
})

test("no log, and a log this office can't read", async ({ page }) => {
  await page.goto(`/runs/${rid(4)}`)
  await expect(logStatus(page)).toHaveText("no run log: the run didn't start")
  await page.goto(`/runs/${rid(1)}`)
  await expect(logStatus(page)).toHaveText("This log uses run-log schema 8, which is older than this office supports")
  await expect(timeline(page)).toHaveCount(0)
})

test("an idle run with no log yet says so", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(4), detail: { run: { status: "idle" }, log_state: "not_started",
    log_message: "not started yet" } } })
  await page.goto(`/runs/${rid(4)}`)
  await expect(logStatus(page)).toHaveText("idle, not started yet")
})

test("a large log shows its reading progress, then its page", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(5), detail: { log_state: "indexing", log_message:
    "reading the log: 120 of 480 MB", bytes_done: 120 << 20, bytes_total: 480 << 20 } } })
  await page.goto(`/runs/${rid(5)}`)
  await expect(logStatus(page)).toHaveText("reading the log: 120 of 480 MB")
  await request.post("/__fixture/run", { data: { id: rid(5), detail: { log_state: "ok", log_message: null } } })
  await expect(timeline(page).getByRole("treeitem").first()).toBeVisible({ timeout: 5_000 })
})

test("a Timeline read while the log is first read says so, then shows", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(5), indexing: true } })
  await page.goto(`/runs/${rid(5)}`)
  await expect(logStatus(page)).toHaveText("reading the log: 120 of 480 MB")
  await request.post("/__fixture/run", { data: { id: rid(5), indexing: false } })
  await expect(timeline(page).getByRole("treeitem").first()).toBeVisible({ timeout: 5_000 })
})

test("run.updated for this run refetches its page", async ({ page, request }) => {
  await page.goto(`/runs/${rid(3)}`)
  await expect(header(page)).toContainText("waiting")
  await request.post("/__fixture/run", { data: { id: rid(3), detail: { run: { status: "finished", ended_at:
    "2026-10-20T10:09:00.000Z" } } } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(3), session_id: "S3", status: "finished", current_nodes: [] } } } })
  await expect(header(page)).toContainText("finished")
})

test("a new live iteration keeps the one before open, and focus where it was", async ({ page, request }) => {
  await page.goto(`/runs/${rid(5)}`)
  const ask = timeline(page).getByRole("treeitem", { name: /^chat#3\/ask/ })
  await ask.focus()
  await request.post("/__fixture/run", { data: { id: rid(5), add: [
    node(45, "chat#4/ask", { status: "open", end_seq: null }), node(44, "chat~4", { status: "expanded" })] } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(5), session_id: "S5", status: "running", current_nodes: ["chat#4/ask"] } } } })
  await expect(timeline(page).getByRole("treeitem").first()).toContainText("chat#4")
  await expect(ask).toBeFocused()
  await expect(timeline(page).getByRole("treeitem", { name: /^iteration chat#3/ })).toHaveAttribute("aria-expanded", "true")
})

test("the Timeline's keys move, open and fold; Older nodes hands focus to what it brought", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  const item = (name: RegExp) => timeline(page).getByRole("treeitem", { name })
  const turn3 = item(/^iteration chat#3/)
  await turn3.focus()
  await page.keyboard.press("ArrowDown")
  await expect(item(/^chat#3\/ask/)).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(item(/^chat~3/)).toBeFocused()
  await page.keyboard.press("ArrowLeft") // to its group
  await expect(turn3).toBeFocused()
  await page.keyboard.press("ArrowLeft") // folds it
  await expect(turn3).toHaveAttribute("aria-expanded", "false")
  await page.keyboard.press("ArrowRight") // opens it
  await expect(turn3).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("ArrowRight") // into it
  await expect(item(/^chat#3\/ask/)).toBeFocused()
  await page.keyboard.press("End")
  const turn1 = item(/^iteration chat#1/)
  await expect(turn1).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(turn1).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Home")
  await expect(turn3).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await expect(turn3).toBeFocused()
  // The last older page: its button goes, and focus moves to the first node it brought (seq 13, in chat#1).
  await page.getByRole("button", { name: "Older nodes" }).focus()
  await page.keyboard.press("Enter")
  await expect(item(/^chat#1\/route/)).toBeFocused()
  await expect(page.getByRole("button", { name: "Older nodes" })).toHaveCount(0)
})

test("a divider and a node's error describe the items they belong to", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  const turn2 = timeline(page).getByRole("treeitem", { name: /^iteration chat#2/ })
  await expect(turn2.nth(1)).toHaveAccessibleDescription("resumed; retried reply")
  await timeline(page).getByRole("treeitem", { name: /^iteration chat#1/ }).click()
  await expect(timeline(page).getByRole("treeitem", { name: /^chat#1\/reply/ })).toHaveAccessibleDescription(
    "AuthError: 401 key (hidden)")
})

test("an indexing header with no message says its progress from its bytes, which aren't announced", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(5), detail: { log_state: "indexing", log_message: null,
    bytes_done: 120 << 20, bytes_total: 480 << 20 } } })
  await page.goto(`/runs/${rid(5)}`)
  await expect(logStatus(page)).toHaveText("reading the log: 120 of 480 MB")
  await expect(logStatus(page).locator('[aria-live="off"]')).toHaveText("120 of 480 MB")
})

test("run.updated for a child refetches the page", async ({ page, request }) => {
  await page.goto(`/runs/${rid(5)}`)
  await expect(header(page)).toContainText("idle")
  await request.post("/__fixture/run", { data: { id: rid(5), detail: { run: { status: "running" } } } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(6), session_id: "S6", parent_run_id: rid(5), status: "running", current_nodes: [] } } } })
  await expect(header(page)).toContainText("running")
})

test("a failed read says why, with Retry; failing to load the secrets says so", async ({ page, request }) => {
  const path = `/api/runs/${rid(5)}`
  await request.post("/__fixture/set", { data: { fail: { [path]: 500 } } })
  await page.goto(`/runs/${rid(5)}`)
  await expect(page.getByRole("alert")).toHaveText(`Couldn't read the run: ${path} failed.`)
  // The page also reads again once the office is first online (throttled to a second); let that read fail too.
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  await page.waitForTimeout(1500)
  await request.post("/__fixture/set", { data: { fail: { [path]: { status: 503, error: "secrets_unavailable",
    message: "couldn't load the secrets to remove" } } } })
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByRole("alert")).toHaveText("Couldn't load the secrets to remove; try again.")
  await request.post("/__fixture/set", { data: { fail: {} } })
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(header(page)).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("the header's Show all reads every child, saying so while it reads", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { runs: crowded(201) } })
  await request.post("/__fixture/run", { data: { id: rid(4000) } })
  await page.goto(`/runs/${rid(4000)}`)
  const kids = header(page).getByRole("link", { name: /^0000[0-9]{4}$/ })
  await expect(kids).toHaveCount(200)
  await request.post("/__fixture/set", { data: { delay: { "/api/runs": 1000 } } })
  await header(page).getByRole("button", { name: "Show all 201" }).click()
  await expect(header(page).getByRole("button", { name: "reading…" })).toBeDisabled()
  await expect(kids).toHaveCount(201)
})

test("a run page opened while the office reconnects reads again once it's back", async ({ page, request }) => {
  await page.goto("/runs")
  await expect(page.getByRole("table", { name: "Runs" })).toContainText(rid(3).slice(-8))
  // The reconnect's snapshot waits, so the page opens while the office is "connecting", and its first read fails.
  const path = `/api/runs/${rid(3)}`
  await request.post("/__fixture/set", { data: { delay: { "/api/company": 3000 }, fail: { [path]: 500 } } })
  await request.post("/__fixture/drop", { data: { ms: 0 } })
  await expect(page.getByText("Reconnecting to the office…")).toBeVisible()
  await page.getByRole("link", { name: rid(3).slice(-8) }).click()
  await expect(page.getByRole("alert")).toContainText("Couldn't read the run")
  await request.post("/__fixture/set", { data: { fail: {} } })
  await expect(header(page)).toContainText("waiting", { timeout: 10_000 })
})

test("on a phone the header stacks", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/runs/${rid(5)}`)
  expect((await header(page).boundingBox())!.width).toBeLessThanOrEqual(390)
  await expect(timeline(page)).toBeVisible()
})
