import { expect, test, type Page } from "@playwright/test"
import { rid } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const timeline = (page: Page) => page.getByRole("tree", { name: "Timeline" })
const nodeDetail = (page: Page, id: string) => page.getByRole("region", { name: `Node ${id}` })

/** Opens run 5's chat#2/reply and returns its detail. */
async function openReply(page: Page) {
  await page.goto(`/runs/${rid(5)}`)
  await timeline(page).getByRole("treeitem", { name: /^iteration chat#2/ }).first().click()
  await timeline(page).getByRole("treeitem", { name: /chat#2\/reply.*succeeded/ }).click()
  return nodeDetail(page, "chat#2/reply")
}

test("a model call opens from node detail: its request, reply, tool calls with the gate's notes, and attempts", async ({ page }) => {
  const detail = await openReply(page)
  const calls = detail.getByRole("list", { name: "Model calls" })
  await expect(calls.getByRole("button")).toHaveCount(2)
  await calls.getByRole("button", { name: "Call 2 · gpt-5 · tool_calls · 2 attempts" }).click()
  const call = page.getByRole("region", { name: "Model call 2" })
  await expect(call).toContainText("1,200 in · 80 out · 800 cached · 40 reasoning")

  // The request: the system prompt, the conversation with who said each message, the tools and the settings.
  const request = call.getByRole("region", { name: "Request" })
  await expect(request).toContainText("You are Kai (@kai), Engineer at Acme.")
  await expect(request).toContainText("Save the notes, then list the folder.")
  await expect(request).toContainText("@ngocbh")
  await request.getByText("Tools (2)").click()
  await expect(request).toContainText("Save a file in the workspace.")
  await request.getByText("Model and settings").click()
  await expect(request).toContainText('"effort": "medium"')

  // The reply: its thought folded, its text.
  const reply = call.getByRole("region", { name: "Reply" })
  await expect(reply).toContainText("Saving the notes, then listing the folder.")
  await expect(reply.getByText("The notes are short: save them, then list.")).toBeHidden()
  await reply.getByText("Thought", { exact: true }).click()
  await expect(reply.getByText("The notes are short: save them, then list.")).toBeVisible()

  // Each tool call: the gate's note shows on its row; opening it shows its arguments and result.
  const tools = call.getByRole("region", { name: "Tool calls" })
  await expect(tools).toContainText("Held, then released: approved by @ngocbh")
  await expect(tools).toContainText("Allowed: read-only")
  const save = tools.getByRole("button", { name: /^workspace_save/ })
  await expect(save).toHaveAttribute("aria-expanded", "false")
  await save.click()
  await expect(save).toHaveAttribute("aria-expanded", "true")
  await expect(tools).toContainText("Ship on Friday.")
  await expect(tools).toContainText("saved notes.md")
  // A long result folds to its first lines until Show all.
  await tools.getByRole("button", { name: /^terminal_run/ }).click()
  await expect(tools).toContainText("notes-11.md")
  await expect(tools).not.toContainText("notes-29.md")
  await tools.getByRole("button", { name: "Show all" }).click()
  await expect(tools).toContainText("notes-29.md")

  // The attempts: the first cut short and retried.
  const attempts = call.getByRole("list", { name: "Attempts" })
  await expect(attempts.getByRole("listitem")).toHaveCount(2)
  await expect(attempts.getByRole("listitem").first()).toContainText("incomplete: the stream ended before its finish event")
  await expect(attempts.getByRole("listitem").first()).toContainText("retried after 0.4 s")

  // Back to the node, focus on the call it came from.
  await call.getByRole("button", { name: "Back to the node" }).click()
  await expect(call).toHaveCount(0)
  await expect(calls.getByRole("button", { name: /^Call 2/ })).toBeFocused()
})

test("Escape goes back from a call to its node, then closes the node", async ({ page }) => {
  const detail = await openReply(page)
  await detail.getByRole("list", { name: "Model calls" }).getByRole("button", { name: /^Call 5/ }).click()
  const call = page.getByRole("region", { name: "Model call 5" })
  await expect(call.getByRole("region", { name: "Reply" })).toContainText("Done.")
  // A text the office cut says where.
  await expect(call.getByRole("region", { name: "Request" })).toContainText("Cut at 64K characters here")
  await page.keyboard.press("Escape")
  await expect(call).toHaveCount(0)
  await expect(detail).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(detail).toHaveCount(0)
})

test("an interrupted call says so", async ({ page }) => {
  await page.goto(`/runs/${rid(6)}`)
  await timeline(page).getByRole("treeitem", { name: /chat#0\/reply/ }).click()
  await nodeDetail(page, "chat#0/reply").getByRole("button", { name: "Call 1 · gpt-5 · interrupted" }).click()
  const call = page.getByRole("region", { name: "Model call 1" })
  await expect(call).toContainText("An interrupt cut this reply")
  await expect(call.getByRole("region", { name: "Reply" })).toContainText("Let me")
})

test("a call the office can't rebuild says why and can retry", async ({ page, request }) => {
  const path = `/api/runs/${rid(5)}/calls/chat%232/reply/5`
  await request.post("/__fixture/set", { data: { fail: { [path]: { status: 409, error: "not_supported",
    message: "this office can't rebuild this model call (DefaultsMismatchError)" } } } })
  const detail = await openReply(page)
  await detail.getByRole("list", { name: "Model calls" }).getByRole("button", { name: /^Call 5/ }).click()
  const call = page.getByRole("region", { name: "Model call 5" })
  await expect(call.getByRole("alert")).toHaveText("this office can't rebuild this model call (DefaultsMismatchError)")
  await request.post("/__fixture/set", { data: { fail: {} } })
  await call.getByRole("button", { name: "Retry" }).click()
  await expect(call.getByRole("region", { name: "Reply" })).toContainText("Done.")
})
