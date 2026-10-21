import { expect, test, type Page } from "@playwright/test"
import { node, rid } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const timeline = (page: Page) => page.getByRole("tree", { name: "Timeline" })
const nodeDetail = (page: Page, id: string) => page.getByRole("region", { name: `Node ${id}` })

test("node detail: output, model, evidence, and an error with its traceback folded", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  await timeline(page).getByRole("treeitem", { name: /^iteration chat#2/ }).first().click()
  await timeline(page).getByRole("treeitem", { name: /chat#2\/reply.*succeeded/ }).click()
  const detail = nodeDetail(page, "chat#2/reply")
  await expect(detail).toContainText("Done.")
  await expect(detail).toContainText("gpt-5") // models["chat/reply"]: no kind needed
  await detail.getByText("Prompt", { exact: true }).click()
  await expect(detail.getByText("Fix the build", { exact: true })).toBeVisible()
  await expect(detail).toContainText("workspace.read")
  await page.getByRole("button", { name: "Older nodes" }).click()
  await timeline(page).getByRole("treeitem", { name: /^iteration chat#1/ }).click()
  await timeline(page).getByRole("treeitem", { name: /chat#1\/reply.*failed/ }).click()
  const failed = nodeDetail(page, "chat#1/reply")
  await expect(failed).toContainText("AuthError: 401 key (hidden)")
  await failed.getByText("Traceback", { exact: true }).click()
  await expect(failed.getByText(/…whole…/)).toBeVisible()
})

test("a case that took its else route says no case matched; __start__ and __end__ are dimmer", async ({ page, request }) => {
  const rec = { cut: [], evidence_left_out: false, withheld: null, size: null }
  await request.post("/__fixture/run", { data: { id: rid(2), add: [
    node(64, "__end__"), node(62, "triage", { status: "routed", handle: "#else" }), node(60, "__start__"),
  ], addEvents: [{ seq: 63, kind: "node_routed", node_id: "triage", payload: { handle: "#else" }, ...rec }] } })
  await page.goto(`/runs/${rid(2)}`)
  const routed = timeline(page).getByRole("treeitem", { name: "triage routed → else (no case matched)" })
  await expect(routed).toContainText("routed → else (no case matched)")
  await routed.click()
  const detail = nodeDetail(page, "triage")
  await expect(detail).toContainText("else (no case matched)")
  await expect(detail).not.toContainText("#else")
  const id = (name: RegExp) => timeline(page).getByRole("treeitem", { name }).locator(".font-mono")
  await expect(id(/^__end__/)).toHaveClass(/text-neutral-500/)
  await expect(id(/^__start__/)).toHaveClass(/text-neutral-500/)
  await expect(id(/^triage/)).not.toHaveClass(/text-neutral-500/)
})

test("a node whose static path has no model shows none", async ({ page }) => {
  await page.goto(`/runs/${rid(2)}`)
  await timeline(page).getByRole("treeitem", { name: /^debrief/ }).click()
  await expect(nodeDetail(page, "debrief")).toContainText("lessons")
  await expect(nodeDetail(page, "debrief").getByText("Model", { exact: true })).toHaveCount(0)
})

test("an open node says its output comes when it ends, and a side chat keeps no evidence", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  await timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ }).click()
  await expect(nodeDetail(page, "chat#3/ask")).toContainText("running: its output appears when it ends")
  await page.goto(`/runs/${rid(6)}`)
  await timeline(page).getByRole("treeitem", { name: /chat#0\/reply/ }).click()
  await expect(nodeDetail(page, "chat#0/reply")).toContainText("Evidence isn't recorded: this flow isn't learnable.")
})

test("a restarted node says where its partial work is", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  await timeline(page).getByRole("treeitem", { name: /^iteration chat#2/ }).nth(1).click()
  await timeline(page).getByRole("treeitem", { name: /chat#2\/reply.*restarted/ }).click()
  await expect(nodeDetail(page, "chat#2/reply")).toContainText(
    "interrupted: its partial work is only in the session's transcript")
})

test("Enter opens the focused node, and Escape closes it with focus on the row", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  const row = timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ })
  await row.focus()
  await page.keyboard.press("Enter")
  await expect(nodeDetail(page, "chat#3/ask")).toBeVisible()
  await expect(row).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Escape")
  await expect(nodeDetail(page, "chat#3/ask")).toHaveCount(0)
  await expect(row).toBeFocused()
})

test("a node read whose secrets can't be loaded says so and can retry", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(6), fail: "secrets_unavailable" } })
  await page.goto(`/runs/${rid(6)}`)
  await timeline(page).getByRole("treeitem", { name: /chat#0\/reply/ }).click()
  await expect(nodeDetail(page, "chat#0/reply").getByRole("alert")).toHaveText(
    /Couldn't load the secrets to remove; try again\./)
  await request.post("/__fixture/run", { data: { id: rid(6), fail: null } })
  await nodeDetail(page, "chat#0/reply").getByRole("button", { name: "Retry" }).click()
  await expect(nodeDetail(page, "chat#0/reply")).toContainText("Quota.")
})

test("on a phone node detail is a sheet over everything, and Escape returns to the row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/runs/${rid(5)}`)
  const row = timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ })
  await row.click()
  const sheet = page.getByRole("dialog", { name: "Node chat#3/ask" })
  await expect(sheet).toBeVisible()
  expect((await sheet.boundingBox())!.width).toBeLessThanOrEqual(390)
  // Nothing behind it takes focus: the sidebar, or the Timeline.
  const menu = page.getByRole("navigation", { name: "HQ" }).getByRole("button", { name: "Menu" })
  await menu.evaluate((el: HTMLElement) => el.focus())
  await expect(menu).not.toBeFocused()
  await row.evaluate((el: HTMLElement) => el.focus())
  await expect(row).not.toBeFocused()
  await page.keyboard.press("Escape")
  await expect(sheet).toHaveCount(0)
  await expect(row).toBeFocused()
})

test("Raw: records by page, a filter, a cut field opened, oversized and withheld stubs, and Download", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  await page.getByRole("tab", { name: "Raw" }).click()
  const raw = page.getByRole("list", { name: "Records" })
  await expect(raw.getByRole("listitem")).toHaveCount(4)
  await page.getByRole("button", { name: "Load more records" }).click()
  await expect(raw.getByRole("listitem")).toHaveCount(6)
  await expect(raw).toContainText("3.0 MB record: too large to preview; download the log")
  await expect(raw).toContainText("a secret couldn't be removed")
  await raw.getByRole("listitem").filter({ hasText: "node_failed" }).getByRole("button", { name: "Open the whole record" }).click()
  await expect(raw).toContainText("…whole…")
  await page.getByRole("combobox", { name: "Kind" }).selectOption("run_resumed")
  await expect(raw.getByRole("listitem")).toHaveCount(1)
  await page.getByRole("combobox", { name: "Kind" }).selectOption("")
  await page.getByRole("searchbox", { name: "Node" }).fill("chat#2")
  await expect(raw.getByRole("listitem")).toHaveCount(2)
  const download = page.getByRole("link", { name: "Download" })
  await expect(download).toHaveAttribute("href", `/api/runs/${rid(5)}/log`)
  await expect(download).toHaveAttribute("download", `${rid(5)}.jsonl`)
})

test("Raw reads newer records on run.updated, and the Timeline is where it was behind it", async ({ page, request }) => {
  await page.goto(`/runs/${rid(6)}`)
  await page.getByRole("tab", { name: "Raw" }).click()
  const raw = page.getByRole("list", { name: "Records" })
  await expect(raw.getByRole("listitem")).toHaveCount(1)
  await request.post("/__fixture/run", { data: { id: rid(6), addEvents: [{ seq: 5, kind: "node_started", node_id:
    "chat#1/reply", payload: {}, cut: [], evidence_left_out: false, withheld: null, size: null }] } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(6), session_id: "S6", status: "running", current_nodes: ["chat#1/reply"] } } } })
  await expect(raw.getByRole("listitem")).toHaveCount(2)
  await expect(raw.getByRole("listitem").last()).toContainText("node_started")
  await page.getByRole("tab", { name: "Timeline" }).click()
  await expect(page.getByRole("tree", { name: "Timeline" }).getByRole("treeitem", { name: /chat#0\/reply/ })).toBeVisible()
})

test("Raw while the log is first read says so, then shows", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(5), indexing: true } })
  await page.goto(`/runs/${rid(5)}`)
  await page.getByRole("tab", { name: "Raw" }).click()
  await expect(page.getByRole("status", { name: "Log" })).toHaveText("reading the log: 120 of 480 MB")
  await request.post("/__fixture/run", { data: { id: rid(5), indexing: false } })
  await expect(page.getByRole("list", { name: "Records" }).getByRole("listitem")).toHaveCount(4, { timeout: 5_000 })
})

test("a Raw read whose secrets can't be loaded says so and can retry", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(6), fail: "secrets_unavailable" } })
  await page.goto(`/runs/${rid(6)}`)
  await page.getByRole("tab", { name: "Raw" }).click()
  await expect(page.getByRole("alert")).toHaveText(/Couldn't load the secrets to remove; try again\./)
  await request.post("/__fixture/run", { data: { id: rid(6), fail: null } })
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByRole("list", { name: "Records" })).toContainText("Quota.")
})

test("a log this office can't read still downloads; a run with no log doesn't", async ({ page }) => {
  await page.goto(`/runs/${rid(1)}`)
  await expect(page.getByRole("link", { name: "Download" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Raw" })).toHaveCount(0)
  await page.goto(`/runs/${rid(4)}`)
  await expect(page.getByRole("link", { name: "Download" })).toHaveCount(0)
})

test("on a phone the tabs fit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/runs/${rid(5)}`)
  await expect(page.getByRole("tab", { name: "Raw" })).toBeVisible()
  expect((await page.getByRole("tablist").boundingBox())!.width).toBeLessThanOrEqual(390)
})
