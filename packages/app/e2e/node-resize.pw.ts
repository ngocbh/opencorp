import { expect, test, type Locator, type Page } from "@playwright/test"
import { node, rid } from "./runs"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const timeline = (page: Page) => page.getByRole("tree", { name: "Timeline" })
const detail = (page: Page) => page.getByRole("region", { name: /^Node / })
const splitter = (page: Page) => page.getByRole("separator", { name: "Resize node detail" })
const box = async (l: Locator) => (await l.boundingBox())!
const width = async (l: Locator) => (await box(l)).width
const valueNow = async (l: Locator) => Number(await l.getAttribute("aria-valuenow"))

/** Opens run 5's open node, chat#3/ask, and returns its row. */
async function open(page: Page) {
  await page.goto(`/runs/${rid(5)}`)
  const row = timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ })
  await row.click()
  await expect(detail(page)).toBeVisible()
  return row
}

/** Room for the Timeline and node detail: the page's content less the splitter. */
async function room(page: Page) {
  return (await width(page.locator("main"))) - (await width(splitter(page)))
}

/** The Timeline's width: from the content's left edge to the splitter. */
async function timelineWidth(page: Page) {
  return (await box(splitter(page))).x - (await box(page.locator("main"))).x
}

/** Drags the splitter by `dx` pixels with the mouse. */
async function drag(page: Page, dx: number) {
  const b = await box(splitter(page))
  const x = b.x + b.width / 2
  const y = b.y + Math.min(b.height / 2, 200)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 3 })
  await page.mouse.move(x + dx, y, { steps: 3 })
  await page.mouse.up()
}

test("node detail opens at half the content width, with a splitter that names what it resizes", async ({ page }) => {
  await open(page)
  const half = (await room(page)) / 2
  expect(Math.abs((await width(detail(page))) - half)).toBeLessThanOrEqual(1)
  const s = splitter(page)
  await expect(s).toHaveAttribute("aria-orientation", "vertical")
  await expect(s).toHaveAttribute("aria-controls", (await detail(page).getAttribute("id"))!)
  await expect(s).toHaveAttribute("aria-valuemin", "320")
  expect(Math.abs((await valueNow(s)) - half)).toBeLessThanOrEqual(1)
  await expect(s).toHaveAttribute("aria-valuetext", `${await valueNow(s)} pixels`)
  await expect(s).toHaveCSS("cursor", "col-resize")
})

test("the splitter is a 12px target with a 1px line, as tall as the row however short node detail is", async ({ page }) => {
  await open(page)
  const s = splitter(page)
  expect(await width(s)).toBe(12)
  await expect(s.locator("span")).toHaveCSS("width", "1px")
  // chat#3/ask is open: its detail is a few lines, shorter than the Timeline beside it.
  const sizes = await s.evaluate((el) => ({
    splitter: el.getBoundingClientRect().height,
    row: el.parentElement!.parentElement!.getBoundingClientRect().height,
  }))
  expect((await box(detail(page))).height).toBeLessThan(sizes.row)
  expect(sizes.splitter).toBe(sizes.row)
})

test("dragging the splitter resizes node detail, down to its min and up to the Timeline's min", async ({ page }) => {
  await open(page)
  const before = await width(detail(page))
  await drag(page, -150)
  expect(Math.abs((await width(detail(page))) - (before + 150))).toBeLessThanOrEqual(2)
  await drag(page, 2000)
  expect(Math.round(await width(detail(page)))).toBe(320)
  await drag(page, -3000)
  expect(Math.round(await timelineWidth(page))).toBe(280)
  await expect(timeline(page)).toBeVisible()
})

test("the splitter's keys: arrows step, Home and End go to the min and max, Enter and a double-click reset", async ({ page }) => {
  await open(page)
  const s = splitter(page)
  const start = await valueNow(s)
  await s.focus()
  await expect(s).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  expect(await valueNow(s)).toBe(start + 16)
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowRight")
  expect(await valueNow(s)).toBe(start - 16)
  await page.keyboard.press("Home")
  expect(await valueNow(s)).toBe(320)
  expect(Math.round(await width(detail(page)))).toBe(320)
  await page.keyboard.press("End")
  const max = Number(await s.getAttribute("aria-valuemax"))
  expect(await valueNow(s)).toBe(max)
  expect(Math.round(await timelineWidth(page))).toBe(280)
  await page.keyboard.press("Enter")
  expect(await valueNow(s)).toBe(start)
  await page.keyboard.press("Home")
  await s.dblclick()
  expect(await valueNow(s)).toBe(start)
})

test("the width is remembered across a reload, and a reset forgets it", async ({ page }) => {
  await open(page)
  await drag(page, -120)
  const chosen = await valueNow(splitter(page))
  await page.reload()
  await timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ }).click()
  expect(await valueNow(splitter(page))).toBe(chosen)
  expect(Math.round(await width(detail(page)))).toBe(chosen)
  await splitter(page).dblclick()
  const reset = await valueNow(splitter(page))
  await page.reload()
  await timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ }).click()
  expect(await valueNow(splitter(page))).toBe(reset)
})

test("a narrower window clamps the width so the Timeline keeps its min", async ({ page }) => {
  await open(page)
  await splitter(page).focus()
  await page.keyboard.press("End")
  await page.setViewportSize({ width: 900, height: 720 })
  await expect.poll(() => timelineWidth(page)).toBeGreaterThanOrEqual(279.5)
  const max = Number(await splitter(page).getAttribute("aria-valuemax"))
  expect(await valueNow(splitter(page))).toBe(max)
  expect(Math.round(await width(detail(page)))).toBe(max)
  expect(Math.round(await timelineWidth(page))).toBe(280)
})

test("Expand gives node detail the whole width and back; Escape still closes it with focus on the row", async ({ page }) => {
  const row = await open(page)
  const expand = detail(page).getByRole("button", { name: "Expand" })
  await expect(expand).toHaveAttribute("aria-pressed", "false")
  await expand.click()
  await expect(expand).toHaveAttribute("aria-pressed", "true")
  await expect(timeline(page)).toBeHidden()
  await expect(splitter(page)).toHaveCount(0)
  expect(Math.abs((await width(detail(page))) - (await width(page.locator("main"))))).toBeLessThanOrEqual(1)
  await expand.click()
  await expect(expand).toHaveAttribute("aria-pressed", "false")
  await expect(timeline(page)).toBeVisible()
  await expect(splitter(page)).toBeVisible()
  await expand.click()
  await page.keyboard.press("Escape")
  await expect(detail(page)).toHaveCount(0)
  await expect(timeline(page)).toBeVisible()
  await expect(row).toBeFocused()
  // It opens next time beside the Timeline again.
  await row.click()
  await expect(timeline(page)).toBeVisible()
  await expect(detail(page).getByRole("button", { name: "Expand" })).toHaveAttribute("aria-pressed", "false")
})

test("long output scrolls inside node detail and wraps", async ({ page, request }) => {
  const rec = { cut: [], withheld: null, size: null }
  const long = `${"x".repeat(3000)}\n${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}`
  await request.post("/__fixture/run", { data: { id: rid(2), add: [node(62, "write")], addEvents: [
    { seq: 63, kind: "node_succeeded", node_id: "write", payload: { value: long }, ...rec }] } })
  await page.goto(`/runs/${rid(2)}`)
  await timeline(page).getByRole("treeitem", { name: /^write/ }).click()
  const d = detail(page)
  await expect(d).toContainText("line 199")
  const size = await d.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight }))
  expect(size.sw).toBeLessThanOrEqual(size.cw)
  expect(size.sh).toBeGreaterThan(size.ch)
  expect((await box(d)).height).toBeLessThanOrEqual(720)
  // The page itself doesn't grow sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)
})

test("on a phone node detail is still the full-screen sheet, with no splitter or Expand", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/runs/${rid(5)}`)
  await timeline(page).getByRole("treeitem", { name: /chat#3\/ask/ }).click()
  const sheet = page.getByRole("dialog", { name: "Node chat#3/ask" })
  await expect(sheet).toBeVisible()
  expect(await box(sheet)).toMatchObject({ x: 0, y: 0, width: 390, height: 844 })
  await expect(splitter(page)).toHaveCount(0)
  await expect(sheet.getByRole("button", { name: "Expand" })).toHaveCount(0)
})
