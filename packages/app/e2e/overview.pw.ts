import { expect, test, type Page } from "@playwright/test"
import { node, rid } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const overview = (page: Page) => page.getByRole("tree", { name: "Overview" })
const timeline = (page: Page) => page.getByRole("tree", { name: "Timeline" })
const nodeDetail = (page: Page, id: string) => page.getByRole("region", { name: `Node ${id}` })

/** One finished turn of @lead's chat (run 3): its START and END, the take, the route, a flow call to `context` that
 *  calls `compacted`, and the reply; the loop and its driver before it. Newest first. */
const TURN = [
  node(24, "chat#0/__end__"), node(22, "chat#0/reply", { kind: "agent" }), node(20, "chat#0/context/__end__"),
  node(19, "chat#0/context/compacted/__end__"),
  node(17, "chat#0/context/compacted/over", { kind: "case", status: "routed", handle: "done" }),
  node(16, "chat#0/context/compacted/__start__"), node(15, "chat#0/context/compacted", { status: "expanded" }),
  node(14, "chat#0/context/__start__"), node(13, "chat#0/context", { kind: "call", status: "expanded" }),
  node(11, "chat#0/route", { status: "routed", handle: "context" }), node(9, "chat#0/heard"),
  node(8, "chat#0/__start__"), node(7, "chat~0", { status: "expanded" }), node(5, "chat", { status: "expanded" }),
]

/** Opens run 3's page with TURN, every page of its nodes read. */
async function openTurn(page: Page, request: import("@playwright/test").APIRequestContext, query = "") {
  await request.post("/__fixture/run", { data: { id: rid(3), add: TURN } })
  await page.goto(`/runs/${rid(3)}${query}`)
  // The fixture's node pages are 8 long: run 3's nodes are two.
  await page.getByRole("button", { name: "Older nodes" }).click()
  await expect(page.getByRole("button", { name: "Older nodes" })).toHaveCount(0)
}

test("Overview is the default: no starts, ends or expansions, a turn's status folded in, a flow call one row", async ({ page, request }) => {
  await openTurn(page, request)
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true")
  const items = overview(page).getByRole("treeitem")
  // The turn: what ran in it, its END's success its status; a flow call's row folds its END's in too.
  const turn = overview(page).getByRole("treeitem", { name: "iteration chat#0 succeeded" })
  await expect(turn).toHaveAttribute("aria-expanded", "true")
  await expect(items).toHaveText([/^▾chat#0succeeded/, /^reply succeeded$/, /^contextsucceeded· 1 step▸$/,
                                  /^route routed → context$/, /^heard succeeded$/])
  for (const hidden of [/__start__/, /__end__/, /^chat~0/, /^chat expanded/])
    await expect(overview(page).getByRole("treeitem", { name: hidden })).toHaveCount(0)
  // Folded, it counts the rows it shows.
  await turn.getByText("chat#0", { exact: true }).click()
  await expect(turn).toContainText("4 nodes")
  await turn.getByText("chat#0", { exact: true }).click()
  // ▸ opens a flow call's nodes, by the same rules; clicking the row itself opens its node.
  const context = overview(page).getByRole("treeitem", { name: "chat#0/context succeeded" })
  await expect(context).toHaveAttribute("aria-expanded", "false")
  const show = context.getByRole("button", { name: "Show the nodes of context" })
  // A tap target like the other row controls.
  expect((await show.boundingBox())!.width).toBeGreaterThanOrEqual(24)
  await show.click()
  await expect(context).toHaveAttribute("aria-expanded", "true")
  const compacted = overview(page).getByRole("treeitem", { name: "chat#0/context/compacted succeeded" })
  await expect(compacted).toContainText("compacted")
  await expect(compacted).toContainText("· 1 step")
  await context.getByText("context", { exact: true }).click()
  await expect(nodeDetail(page, "chat#0/context")).toBeVisible()
  await expect(context).toHaveAttribute("aria-selected", "true")
  // The Timeline still shows every node.
  await page.getByRole("tab", { name: "Timeline" }).click()
  await timeline(page).getByRole("treeitem", { name: /^iteration chat#0/ }).first().click()
  await expect(timeline(page).getByRole("treeitem", { name: /^chat#0\/__end__ succeeded/ })).toBeVisible()
})

test("Overview's keys move over the rows on show, open and fold a flow call, and Enter opens its node", async ({ page, request }) => {
  await openTurn(page, request)
  const item = (name: string) => overview(page).getByRole("treeitem", { name })
  await item("chat#0/reply succeeded").focus()
  await page.keyboard.press("ArrowDown")
  await expect(item("chat#0/context succeeded")).toBeFocused()
  await page.keyboard.press("ArrowDown") // past its folded nodes
  await expect(item("chat#0/route routed → context")).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await page.keyboard.press("ArrowRight") // opens it
  await expect(item("chat#0/context succeeded")).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("ArrowRight") // into it
  await expect(item("chat#0/context/compacted succeeded")).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowDown")
  await expect(item("chat#0/context/compacted/over routed → done")).toBeFocused()
  await page.keyboard.press("ArrowLeft") // to its call
  await expect(item("chat#0/context/compacted succeeded")).toBeFocused()
  await page.keyboard.press("ArrowLeft") // folds it
  await expect(item("chat#0/context/compacted succeeded")).toHaveAttribute("aria-expanded", "false")
  await page.keyboard.press("Enter")
  await expect(nodeDetail(page, "chat#0/context/compacted")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(item("chat#0/context/compacted succeeded")).toBeFocused()
  // Folding a call over the row in focus moves focus to the call.
  await item("chat#0/context succeeded").getByRole("button", { name: "Hide the nodes of context" }).click()
  await expect(item("chat#0/context succeeded")).toBeFocused()
  await expect(item("chat#0/context succeeded")).toHaveAttribute("aria-expanded", "false")
})

test("the node shown is in the address; a link to one opens it, in the Timeline when Overview hides it", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(2), add: [
    node(9, "plan/__end__"), node(8, "plan/draft", { kind: "code" }), node(7, "plan/__start__"),
    node(6, "plan", { kind: "call", status: "expanded" }),
  ] } })
  await page.goto(`/runs/${rid(2)}`)
  await overview(page).getByRole("treeitem", { name: "debrief succeeded" }).click()
  await expect(page).toHaveURL(`/runs/${rid(2)}?node=1`)
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(`/runs/${rid(2)}`)

  // A node in a folded flow call: Overview, its call opened.
  await page.goto(`/runs/${rid(2)}?node=8`)
  await expect(nodeDetail(page, "plan/draft")).toBeVisible()
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true")
  // The call's END succeeded, so it did.
  await expect(overview(page).getByRole("treeitem", { name: "plan succeeded" })).toHaveAttribute("aria-expanded", "true")
  await expect(overview(page).getByRole("treeitem", { name: "plan/draft succeeded" })).toHaveAttribute("aria-selected", "true")

  // An END, which Overview hides: the Timeline.
  await page.goto(`/runs/${rid(2)}?node=9`)
  await expect(nodeDetail(page, "plan/__end__")).toBeVisible()
  await expect(page.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true")
  await expect(timeline(page).getByRole("treeitem", { name: "plan/__end__ succeeded" })).toHaveAttribute("aria-selected", "true")
  // Escape returns focus to the shown tree.
  await page.keyboard.press("Escape")
  await expect(nodeDetail(page, "plan/__end__")).toHaveCount(0)
  await expect(timeline(page).getByRole("treeitem").first()).toBeFocused()
})

test("Overview follows a live run: nodes that land show where they belong, a call's fold and focus kept", async ({ page, request }) => {
  // @lead's turn while its context call runs: compacted's route is open.
  const over = node(17, "chat#0/context/compacted/over", { kind: "case", status: "open", end_seq: null })
  await request.post("/__fixture/run", { data: { id: rid(3), add: [
    over, node(16, "chat#0/context/compacted/__start__"), node(15, "chat#0/context/compacted", { status: "expanded" }),
    node(14, "chat#0/context/__start__"), node(13, "chat#0/context", { kind: "call", status: "expanded" }),
    node(11, "chat#0/route", { status: "routed", handle: "context" }), node(9, "chat#0/heard"),
    node(7, "chat~0", { status: "expanded" }),
  ] } })
  await page.goto(`/runs/${rid(3)}`)
  const item = (name: string) => overview(page).getByRole("treeitem", { name })
  await expect(item("iteration chat#0 open")).toBeVisible()
  await item("chat#0/context open").getByRole("button", { name: "Show the nodes of context" }).click()
  await item("chat#0/context/compacted open").focus()
  // The route ends, the calls return, the reply runs and the turn ends.
  await request.post("/__fixture/run", { data: { id: rid(3), update: [{ ...over, status: "routed", handle: "done",
    end_seq: 18 }], add: [
    node(24, "chat#0/__end__"), node(22, "chat#0/reply", { kind: "agent" }), node(20, "chat#0/context/__end__"),
    node(19, "chat#0/context/compacted/__end__"),
  ] } })
  await request.post("/__fixture/emit", { data: { event: { type: "run.updated", data: {
    run_id: rid(3), session_id: "S3", status: "idle", current_nodes: [] } } } })
  await expect(item("iteration chat#0 succeeded")).toBeVisible()
  await expect(item("chat#0/reply succeeded")).toBeVisible()
  await expect(item("chat#0/context succeeded")).toHaveAttribute("aria-expanded", "true")
  await expect(item("chat#0/context/compacted succeeded")).toBeFocused()
  for (const hidden of [/__end__/, /__start__/, /^chat~0/])
    await expect(overview(page).getByRole("treeitem", { name: hidden })).toHaveCount(0)
})

test("a link to a node on an older page reads the pages before until it comes, and opens it", async ({ page, request }) => {
  // Run 5's oldest node, `chat` (seq 1), is on its last node page.
  await page.goto(`/runs/${rid(5)}?node=1`)
  await expect(nodeDetail(page, "chat")).toBeVisible()
  await expect(page.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("button", { name: "Older nodes" })).toHaveCount(0)
})

test("closing a node opened in another view returns focus to its row in the view shown", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  const ask = overview(page).getByRole("treeitem", { name: /^chat#3\/ask/ })
  await ask.click()
  await expect(nodeDetail(page, "chat#3/ask")).toBeVisible()
  // The row that opened it is in Overview, now hidden; focus is in the node view as it closes.
  await page.getByRole("tab", { name: "Timeline" }).click()
  await nodeDetail(page, "chat#3/ask").getByRole("heading", { name: "Node chat#3/ask" }).click()
  await page.keyboard.press("Escape")
  await expect(nodeDetail(page, "chat#3/ask")).toHaveCount(0)
  await expect(timeline(page).getByRole("treeitem", { name: /^chat#3\/ask/ })).toBeFocused()
})
