import { expect, test, type Page } from "@playwright/test"
import { node, rid, valueRow } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const timeline = (page: Page) => page.getByRole("tree", { name: "Timeline" })
/** Overview, the run page's default view. */
const overview = (page: Page) => page.getByRole("tree", { name: "Overview" })
const nodeDetail = (page: Page, id: string) => page.getByRole("region", { name: `Node ${id}` })
/** A section's title, in the order the node view shows them. */
const sections = (detail: ReturnType<typeof nodeDetail>) => detail.locator("section > h3").allTextContents()

test("an agent node: Metadata, its model calls and Outputs, a row each, and a whole value opens in place", async ({ page }) => {
  await page.goto(`/runs/${rid(5)}`)
  await overview(page).getByRole("treeitem", { name: /^iteration chat#2/ }).first().click()
  await overview(page).getByRole("treeitem", { name: /chat#2\/reply.*succeeded/ }).click()
  const detail = nodeDetail(page, "chat#2/reply")
  await expect(detail.getByRole("region", { name: "Outputs" })).toBeVisible()
  // No Inputs: the log doesn't name what an agent's binding read.
  expect(await sections(detail)).toEqual(["Metadata", "Outputs"])
  await expect(detail.getByRole("heading", { name: "Model calls" })).toBeVisible()
  const metadata = detail.getByRole("region", { name: "Metadata" })
  await expect(metadata).toContainText("Kindagent")
  await expect(metadata).toContainText("Statussucceeded")
  await expect(metadata).toContainText("Modelgpt-5")
  await expect(metadata.locator("time")).toHaveAttribute("datetime", /Z$/)
  await expect(metadata).toContainText("Duration4.3s")
  // Each output: its name, type and preview; a value the preview doesn't show whole opens with ›.
  const outputs = detail.getByRole("region", { name: "Outputs" })
  await expect(outputs).toContainText('outputstr"Done."')
  await expect(outputs).toContainText("new_messageslist[object]3 messages")
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

test("a START shows what it received; an END what it returned and what it gathered", async ({ page, request }) => {
  const start = node(70, "c/__start__", { kind: "start" })
  const end = node(74, "c/__end__", { kind: "end" })
  await request.post("/__fixture/run", { data: { id: rid(2), add: [end, start], details: {
    70: { node: start, model: null, started_at: null, ended_at: null, inputs: [], failure: null,
          outputs: [valueRow("text", "owls", { seq: 9 })] },
    74: { node: end, model: null, started_at: null, ended_at: null, failure: null,
          outputs: [valueRow("loud", "owls!", { seq: 17 }), valueRow("ready", "ready", { seq: 17 })],
          inputs: [valueRow("input", { text: "owls" }, { seq: 9, type: "object" }),
                   valueRow("prep.output", "ready", { seq: 14, type: "str" })] },
  } } })
  // Overview hides them: the Timeline shows them.
  await page.goto(`/runs/${rid(2)}`)
  await page.getByRole("tab", { name: "Timeline" }).click()
  await timeline(page).getByRole("treeitem", { name: /^c\/__start__/ }).click()
  const opened = nodeDetail(page, "c/__start__")
  await expect(opened.getByRole("region", { name: "Outputs" })).toContainText('text"owls"')
  expect(await sections(opened)).toEqual(["Metadata", "Outputs"])
  await expect(opened.getByRole("region", { name: "Metadata" })).toContainText("Kindstart")

  await timeline(page).getByRole("treeitem", { name: /^c\/__end__/ }).click()
  const ended = nodeDetail(page, "c/__end__")
  await expect(ended.getByRole("region", { name: "Outputs" })).toContainText('loud"owls!"')
  expect(await sections(ended)).toEqual(["Metadata", "Inputs", "Outputs"])
  const inputs = ended.getByRole("region", { name: "Inputs" })
  await expect(inputs).toContainText("inputobject{text}")
  await expect(inputs).toContainText('prep.outputstr"ready"')
  await inputs.getByRole("button", { name: "Open input" }).click()
  await expect(ended.getByRole("region", { name: "Input input" })).toContainText('"text": "owls"')
  await ended.getByRole("button", { name: "Back to the node" }).click()
  await expect(inputs.getByRole("button", { name: "Open input" })).toBeFocused()
})

test("a case's route is its work section; a node with nothing more shows its Metadata only", async ({ page, request }) => {
  await request.post("/__fixture/run", { data: { id: rid(2), add: [
    node(62, "triage", { kind: "case", status: "routed", handle: "billing" }), node(60, "plan", { kind: "code" }),
  ] } })
  await page.goto(`/runs/${rid(2)}`)
  await overview(page).getByRole("treeitem", { name: /^triage/ }).click()
  const routed = nodeDetail(page, "triage")
  await expect(routed.getByRole("region", { name: "Route" })).toContainText("Tookbilling")
  expect(await sections(routed)).toEqual(["Metadata", "Route"])
  await overview(page).getByRole("treeitem", { name: /^plan/ }).click()
  const plain = nodeDetail(page, "plan")
  await expect(plain.getByRole("region", { name: "Metadata" })).toContainText("Kindcode")
  await expect(plain).not.toContainText("reading…")
  expect(await sections(plain)).toEqual(["Metadata"])
})

test("a value too large to show, or not rebuilt, says why and has nothing to open; a cut one says so open", async ({ page, request }) => {
  const shown = node(60, "big", { kind: "code" })
  await request.post("/__fixture/run", { data: { id: rid(2), add: [shown], details: {
    60: { node: shown, model: null, started_at: null, ended_at: null, inputs: [], failure: null, outputs: [
      valueRow("output", null, { missing: "too_large", size: 3 * 2 ** 20 }),
      valueRow("new_messages", null, { missing: "not_rebuilt" }),
      valueRow("note", "a…", { cut: [""] }),
    ] },
  } } })
  await page.goto(`/runs/${rid(2)}`)
  await overview(page).getByRole("treeitem", { name: /^big/ }).click()
  const outputs = nodeDetail(page, "big").getByRole("region", { name: "Outputs" })
  await expect(outputs).toContainText("3.0 MB: too large to show; download the log")
  await expect(outputs).toContainText("this office couldn't rebuild it from the log")
  await expect(outputs.getByRole("button")).toHaveCount(1)
  await outputs.getByRole("button", { name: "Open note" }).click()
  await expect(nodeDetail(page, "big").getByRole("region", { name: "Output note" })).toContainText(
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
