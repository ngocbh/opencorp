import { expect, test, type Page } from "@playwright/test"
import { DERIVED, node, rid, valueRow } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const timeline = (page: Page) => page.getByRole("tree", { name: "Timeline" })
/** Overview, the run page's default view. */
const overview = (page: Page) => page.getByRole("tree", { name: "Overview" })
const nodeDetail = (page: Page, id: string) => page.getByRole("region", { name: `Node ${id}` })
/** The node view's section titles, in the order it shows them. */
const sections = (detail: ReturnType<typeof nodeDetail>) => detail.locator("section > h3")

/** Opens run 5's chat#2/reply and returns its node view. */
async function openReply(page: Page) {
  await page.goto(`/runs/${rid(5)}`)
  await overview(page).getByRole("treeitem", { name: /^iteration chat#2/ }).first().click()
  await overview(page).getByRole("treeitem", { name: /chat#2\/reply.*succeeded/ }).click()
  return nodeDetail(page, "chat#2/reply")
}

test("an agent node: Metadata, Inputs, its model calls and Outputs, each typed, and a whole value opens in place", async ({ page }) => {
  const detail = await openReply(page)
  await expect(sections(detail)).toHaveText(["Metadata", "Inputs", "Outputs"])
  await expect(detail.getByRole("heading", { name: "Model calls" })).toBeVisible()
  const metadata = detail.getByRole("region", { name: "Metadata" })
  await expect(metadata).toContainText("Kindagent")
  await expect(metadata).toContainText("Statussucceeded")
  await expect(metadata).toContainText("Modelgpt-5")
  await expect(metadata.locator("time")).toHaveAttribute("datetime", /Z$/)
  await expect(metadata).toContainText("Duration4.3s")
  // Each input as the node bound it: its name, type and preview; a memory as the run recorded it; one the run wasn't
  // given says so.
  const inputs = detail.getByRole("region", { name: "Inputs" })
  await expect(inputs).toContainText('summarystr""')
  await expect(inputs).toContainText("saidlist(Message)1 message")
  await expect(inputs).toContainText("personPerson{name, handle, title, company, reports_to}")
  await expect(inputs).toContainText("profileFileMemory{identity, type, settings, version, recall, tools}")
  await expect(inputs).toContainText("extraOptional(str)not given")
  await inputs.getByRole("button", { name: "Open profile" }).click()
  await expect(detail.getByRole("region", { name: "Input profile" })).toContainText('"text": "Ship small."')
  await detail.getByRole("button", { name: "Back to the node" }).click()
  // Each output: its name, type and preview; a value the preview doesn't show whole opens with ›.
  const outputs = detail.getByRole("region", { name: "Outputs" })
  await expect(outputs).toContainText('outputOptional(str)"Done."')
  await expect(outputs).toContainText("new_messageslist(Message)3 messages")
  await expect(outputs.getByRole("button", { name: "Open output" })).toHaveCount(0)
  const open = outputs.getByRole("button", { name: "Open new_messages" })
  await open.click()
  const value = detail.getByRole("region", { name: "Output new_messages" })
  await expect(value).toContainText("Saving the notes, then listing the folder.")
  await expect(value.getByRole("heading", { name: "Output new_messages" })).toBeFocused()
  // Escape goes back to the node, focus on the button that opened it; again closes the node.
  await page.keyboard.press("Escape")
  await expect(value).toHaveCount(0)
  await expect(open).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(detail).toHaveCount(0)
})

test("its detail shows at once; its inputs and typed outputs come with its view, a loading row meanwhile", async ({ page, request }) => {
  const path = `/api/runs/${rid(5)}/nodes/31/view`
  await request.post("/__fixture/set", { data: { delay: { [path]: 3000 } } })
  const detail = await openReply(page)
  const inputs = detail.getByRole("region", { name: "Inputs" })
  const outputs = detail.getByRole("region", { name: "Outputs" })
  await expect(inputs).toHaveText("Inputsreading the log…")
  await expect(detail.getByRole("region", { name: "Metadata" })).toContainText("Modelgpt-5")
  // The reply its record holds shows with its stored kind; the new messages derived from other records wait.
  await expect(outputs).toContainText('outputstr"Done."')
  await expect(outputs).toContainText("new_messagesreading the log…")
  await expect(outputs).toContainText("new_messageslist(Message)3 messages")
  await expect(inputs).toContainText("saidlist(Message)1 message")

  // A view the office can't read says why, its outputs as the detail has them, and can retry.
  await request.post("/__fixture/set", { data: { delay: {}, fail: { [path]: { status: 409, error: "not_supported",
    message: "this office can't read this node's values (RunLogSchemaError)" } } } })
  await page.reload()
  const again = nodeDetail(page, "chat#2/reply")
  await expect(again.getByRole("region", { name: "Inputs" }).getByRole("alert")).toHaveText(
    "this office can't read this node's values (RunLogSchemaError)")
  await expect(again.getByRole("region", { name: "Outputs" })).toContainText(`new_messages${DERIVED}`)
  await request.post("/__fixture/set", { data: { fail: {} } })
  await again.getByRole("region", { name: "Inputs" }).getByRole("button", { name: "Retry" }).click()
  await expect(again.getByRole("region", { name: "Inputs" })).toContainText("saidlist(Message)1 message")
})

test("a START shows what it received; an END what it gathered and returned, each typed", async ({ page, request }) => {
  const start = node(70, "c/__start__", { kind: "start" })
  const end = node(74, "c/__end__", { kind: "end" })
  const input = (name: string, type: string, value: unknown) => valueRow(name, value, { seq: null, type })
  await request.post("/__fixture/run", { data: { id: rid(2), add: [end, start], views: {
    70: { kind: "start", inputs: [input("text", "str", "owls")], outputs: [input("output", '{"text":str}', { text: "owls" })],
          missing: null },
    74: { kind: "end", inputs: [input("loud", "Any", "owls!"), input("ready", "str", "ready")],
          outputs: [input("output", '{"loud":Any,"ready":str}', { loud: "owls!", ready: "ready" })], missing: null },
  } } })
  // Overview hides them: the Timeline shows them.
  await page.goto(`/runs/${rid(2)}`)
  await page.getByRole("tab", { name: "Timeline" }).click()
  await timeline(page).getByRole("treeitem", { name: /^c\/__start__/ }).click()
  const opened = nodeDetail(page, "c/__start__")
  await expect(sections(opened)).toHaveText(["Metadata", "Inputs", "Outputs"])
  await expect(opened.getByRole("region", { name: "Inputs" })).toContainText('textstr"owls"')
  await expect(opened.getByRole("region", { name: "Outputs" })).toContainText('output{"text":str}{text}')
  await expect(opened.getByRole("region", { name: "Metadata" })).toContainText("Kindstart")

  await timeline(page).getByRole("treeitem", { name: /^c\/__end__/ }).click()
  const ended = nodeDetail(page, "c/__end__")
  const inputs = ended.getByRole("region", { name: "Inputs" })
  await expect(inputs).toContainText('loudAny"owls!"')
  await expect(inputs).toContainText('readystr"ready"')
  await ended.getByRole("region", { name: "Outputs" }).getByRole("button", { name: "Open output" }).click()
  await expect(ended.getByRole("region", { name: "Output output" })).toContainText('"loud": "owls!"')
  await ended.getByRole("button", { name: "Back to the node" }).click()
  await expect(ended.getByRole("region", { name: "Outputs" }).getByRole("button", { name: "Open output" })).toBeFocused()
})

test("a node whose run's flow no longer loads says why it has no inputs, with what its records hold", async ({ page, request }) => {
  const shown = node(60, "plan", { kind: null })
  const why = "the run's flow doesn't load: node 'plan': `code:` file './helpers.ts' does not exist"
  await request.post("/__fixture/run", { data: { id: rid(2), add: [shown], views: {
    60: { kind: null, inputs: null, missing: why, outputs: [valueRow("output", "ready", { seq: null })] },
  } } })
  await page.goto(`/runs/${rid(2)}`)
  await overview(page).getByRole("treeitem", { name: /^plan/ }).click()
  const plain = nodeDetail(page, "plan")
  await expect(plain.getByRole("region", { name: "Inputs" })).toHaveText(`Inputs${why}`)
  await expect(plain.getByRole("region", { name: "Outputs" })).toContainText('output"ready"')
})

test("a case's route is its work section; a node with nothing more shows its Metadata only", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(2), add: [
    node(62, "triage", { kind: "case", status: "routed", handle: "billing" }), node(60, "plan", { kind: "code" }),
  ] } })
  await page.goto(`/runs/${rid(2)}`)
  await overview(page).getByRole("treeitem", { name: /^triage/ }).click()
  const routed = nodeDetail(page, "triage")
  await expect(routed.getByRole("region", { name: "Route" })).toContainText("Tookbilling")
  await expect(sections(routed)).toHaveText(["Metadata", "Route"])
  await overview(page).getByRole("treeitem", { name: /^plan/ }).click()
  const plain = nodeDetail(page, "plan")
  await expect(plain.getByRole("region", { name: "Metadata" })).toContainText("Kindcode")
  await expect(plain).not.toContainText("reading")
  await expect(sections(plain)).toHaveText(["Metadata"])
})

test("a value too large to show, or not given, says why and has nothing to open; a cut one says so open", async ({ page, request }) => {
  const shown = node(60, "big", { kind: "code" })
  await request.post("/__fixture/run", { data: { id: rid(2), add: [shown], views: {
    60: { kind: "code", inputs: [valueRow("extra", null, { seq: null, type: "Optional(str)", missing: "not given" })],
          missing: null, outputs: [
      valueRow("output", null, { seq: null, missing: "too large to show; download the log", size: 3 * 2 ** 20 }),
      valueRow("note", "a…", { seq: null, cut: [""] }),
    ] },
  } } })
  await page.goto(`/runs/${rid(2)}`)
  await overview(page).getByRole("treeitem", { name: /^big/ }).click()
  const opened = nodeDetail(page, "big")
  const outputs = opened.getByRole("region", { name: "Outputs" })
  await expect(outputs).toContainText("3.0 MB: too large to show; download the log")
  await expect(opened.getByRole("region", { name: "Inputs" })).toContainText("extraOptional(str)not given")
  await expect(opened.getByRole("region", { name: "Inputs" }).getByRole("button")).toHaveCount(0)
  await expect(outputs.getByRole("button")).toHaveCount(1)
  await outputs.getByRole("button", { name: "Open note" }).click()
  await expect(opened.getByRole("region", { name: "Output note" })).toContainText(
    "Part of this value is too large to show whole; download the log.")
})

/** Whether CSS color `color` is dark: an rgb(), lab() or oklch() lightness under half. */
function isDark(color: string): boolean {
  const lightness = /^(?:ok)?lab\(([0-9.]+)(%?)|^oklch\(([0-9.]+)(%?)/.exec(color)
  if (lightness) {
    const [value, percent] = lightness[1] !== undefined ? [lightness[1], lightness[2]] : [lightness[3], lightness[4]]
    return Number(value) / (percent ? 100 : color.startsWith("lab") ? 100 : 1) < 0.5
  }
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color)
  return !!rgb && (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 3 < 128
}

test("on a phone in the dark theme the node view is a dark sheet whose rows fit, a value opening in it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto(`/runs/${rid(5)}`)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await overview(page).getByRole("treeitem", { name: /^iteration chat#2/ }).first().click()
  await overview(page).getByRole("treeitem", { name: /chat#2\/reply.*succeeded/ }).click()
  const sheet = page.getByRole("dialog", { name: "Node chat#2/reply" })
  const outputs = sheet.getByRole("region", { name: "Outputs" })
  await expect(outputs).toContainText("3 messages")
  const fits = (el: Element) => el.scrollWidth <= el.clientWidth
  expect(await sheet.evaluate(fits)).toBe(true)
  expect(await outputs.evaluate(fits)).toBe(true)
  expect(isDark(await sheet.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(true)
  expect(isDark(await outputs.getByText("new_messages").evaluate((el) => getComputedStyle(el).color))).toBe(false)
  // A tap target like the other row controls.
  const open = outputs.getByRole("button", { name: "Open new_messages" })
  expect((await open.boundingBox())!.width).toBeGreaterThanOrEqual(24)
  await open.click()
  const value = sheet.getByRole("region", { name: "Output new_messages" })
  await expect(value).toContainText("Saving the notes, then listing the folder.")
  expect(await sheet.evaluate(fits)).toBe(true)
  expect(isDark(await value.locator("pre").evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(true)
  await sheet.getByRole("button", { name: "Back to the node" }).click()
  await expect(open).toBeFocused()
})
