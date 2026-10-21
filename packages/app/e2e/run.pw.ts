import { expect, test, type Page } from "@playwright/test"
import { rid } from "./runs"

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
  for (const text of ["chat", "shared/flows/chat.yaml", "b".repeat(12), "a".repeat(12), "idle", "@ngocbh", "kai, ann",
                      "1,200 in · 300 out · $0.0123", "Every signed-in human can read every run log"])
    await expect(header(page)).toContainText(text)
  await expect(header(page).getByRole("link", { name: `replaces …${rid(4).slice(-4)}` })).toHaveAttribute("href", `/runs/${rid(4)}`)
  await expect(header(page).getByRole("link", { name: rid(6).slice(-8) })).toBeVisible() // a child
  await header(page).getByRole("button", { name: "Copy session id" }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("S5")
  await expect(page.getByRole("navigation", { name: "HQ" }).getByRole("link", { name: "Run Logs" })).toHaveClass(/active/)
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

test("on a phone the header stacks", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/runs/${rid(5)}`)
  expect((await header(page).boundingBox())!.width).toBeLessThanOrEqual(390)
  await expect(timeline(page)).toBeVisible()
})
