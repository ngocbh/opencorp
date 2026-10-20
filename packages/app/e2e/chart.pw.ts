import { expect, test, type Page } from "@playwright/test"
import { acme, SHA, wide } from "./company"

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

/** Opens the company view on the chart. */
async function openChart(page: Page) {
  await page.goto("/")
  await page.getByRole("radio", { name: "Chart" }).click()
  const chart = page.getByRole("figure", { name: "Acme org chart" })
  await expect(chart.getByRole("button", { name: "Ngoc, CEO" })).toBeVisible()
  return chart
}

/** The canvas's transform as [k, x, y]. */
const transform = async (page: Page) =>
  (await page.getByTestId("chart-canvas").getAttribute("data-transform"))!.split(",").map(Number)

test("cards and elbow lines, one line per drawn manager and report", async ({ page }) => {
  const chart = await openChart(page)
  await expect(chart.getByRole("button", { name: "Ann, Designer" })).toBeVisible()
  await expect(chart.locator("svg path[data-edge]")).toHaveCount(4) // ngocbh>ann, ngocbh>lead, lead>kai, lead>minh
  await expect(chart.locator('path[data-edge="lead>kai"]')).toHaveAttribute("d", /^M [\d.]+ [\d.]+ V [\d.]+ H [\d.]+ V [\d.]+$/)
  // A card says what the list's row says: status, cards for the viewer, cost.
  await expect(chart.getByRole("button", { name: "Kai, Engineer" }).getByTestId("status")).toHaveAttribute("data-status", "waiting")
  await expect(chart.getByRole("button", { name: "Kai, Engineer" }).getByTestId("needs-you")).toHaveText("1")
  await expect(chart.getByRole("button", { name: "Minh, Engineer" }).getByTestId("cost")).toHaveText("$0.00 +1 unpriced")
  await expect(chart.getByRole("button", { name: "Kai, Engineer" })).toHaveAccessibleDescription("waiting · 1 card for you · $0.42")
})

test("dragging pans the chart by the pointer's travel, even when it starts on a card", async ({ page }) => {
  const chart = await openChart(page)
  const [, x0, y0] = await transform(page)
  const card = (await chart.getByRole("button", { name: "Ann, Designer" }).boundingBox())!
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2)
  await page.mouse.down()
  await page.mouse.move(card.x + card.width / 2 + 100, card.y + card.height / 2 + 20, { steps: 5 })
  await page.mouse.up()
  const [, x1, y1] = await transform(page)
  expect([Math.round(x1 - x0), Math.round(y1 - y0)]).toEqual([100, 20])
  await expect(page.getByRole("complementary")).toHaveCount(0) // a drag isn't a click
  // A drag on the background pans too.
  const view = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(view.x + 10, view.y + 10)
  await page.mouse.down()
  await page.mouse.move(view.x + 40, view.y + 10, { steps: 3 })
  await page.mouse.up()
  expect(Math.round((await transform(page))[1] - x1)).toBe(30)
})

test("only a primary-button press pans: a right-button press or a hover after a lost release doesn't", async ({ page }) => {
  await openChart(page)
  const before = await page.getByTestId("chart-canvas").getAttribute("data-transform")
  const view = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(view.x + 10, view.y + 10)
  await page.mouse.down({ button: "right" })
  await page.mouse.move(view.x + 80, view.y + 40, { steps: 4 })
  await page.mouse.up({ button: "right" })
  await page.mouse.move(view.x + 150, view.y + 60, { steps: 4 })
  expect(await page.getByTestId("chart-canvas").getAttribute("data-transform")).toBe(before)
  // A press whose release happened outside the window: the next move comes with no button held.
  await page.getByTestId("chart-viewport").evaluate((el) => {
    const r = el.getBoundingClientRect()
    const send = (type: string, x: number, buttons: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: type === "pointerdown" ? 0 : -1, buttons, clientX: r.left + x, clientY: r.top + 20, bubbles: true }))
    send("pointerdown", 20, 1)
    send("pointermove", 60, 0)
    send("pointermove", 120, 0)
  })
  expect(await page.getByTestId("chart-canvas").getAttribute("data-transform")).toBe(before)
})

test("after a drag, a click or Enter on a card opens the side panel again", async ({ page }) => {
  const chart = await openChart(page)
  const ann = chart.getByRole("button", { name: "Ann, Designer" })
  const card = (await ann.boundingBox())!
  await page.mouse.move(card.x + 20, card.y + 20)
  await page.mouse.down()
  await page.mouse.move(card.x + 60, card.y + 20, { steps: 3 })
  await page.mouse.up()
  await ann.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("complementary", { name: "Ann" })).toBeVisible()
})

test("the wheel and the buttons zoom; Fit goes back to the whole chart", async ({ page }) => {
  await openChart(page)
  const fitted = await page.getByTestId("chart-canvas").getAttribute("data-transform")
  const box = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const [k0] = await transform(page)
  await page.mouse.wheel(0, -300)
  await expect.poll(async () => (await transform(page))[0]).toBeGreaterThan(k0)
  const [k1] = await transform(page)
  await page.getByRole("button", { name: "Zoom out" }).click()
  expect((await transform(page))[0]).toBeLessThan(k1)
  await page.getByRole("button", { name: "Zoom in" }).click()
  await page.getByRole("button", { name: "Fit" }).click()
  expect(await page.getByTestId("chart-canvas").getAttribute("data-transform")).toBe(fitted)
})

test("the wheel over the chart doesn't scroll the page", async ({ page }) => {
  await openChart(page)
  const box = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 300)
  await expect.poll(async () => (await transform(page))[0]).toBeLessThan(1)
  expect(await page.evaluate(() => scrollY)).toBe(0)
})

test("while the chart shows its fit, it fits again when the view resizes or the chart changes size", async ({ page }) => {
  const chart = await openChart(page)
  const canvas = page.getByTestId("chart-canvas")
  const first = await canvas.getAttribute("data-transform")
  await page.setViewportSize({ width: 1000, height: 700 })
  await expect(canvas).not.toHaveAttribute("data-transform", first!)
  const resized = await canvas.getAttribute("data-transform")
  await page.getByRole("button", { name: "Fit" }).click()
  await expect(canvas).toHaveAttribute("data-transform", resized!)
  await chart.getByRole("button", { name: "Lead's branch", exact: true }).click() // narrower: two cards wide, not three
  await expect(canvas).not.toHaveAttribute("data-transform", resized!)
  const closed = await canvas.getAttribute("data-transform")
  await page.getByRole("button", { name: "Fit" }).click()
  await expect(canvas).toHaveAttribute("data-transform", closed!)
})

test("after a drag, a resize keeps the chart where the viewer put it", async ({ page }) => {
  await openChart(page)
  const view = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(view.x + 10, view.y + 10)
  await page.mouse.down()
  await page.mouse.move(view.x + 60, view.y + 30, { steps: 3 })
  await page.mouse.up()
  const dragged = await page.getByTestId("chart-canvas").getAttribute("data-transform")
  await page.setViewportSize({ width: 1000, height: 700 })
  await expect.poll(() => page.getByTestId("chart-viewport").evaluate((el) => el.clientWidth)).toBeLessThan(view.width)
  expect(await page.getByTestId("chart-canvas").getAttribute("data-transform")).toBe(dragged)
})

test("opening the panel by mouse or by Enter does the same, and keeps the selected card in view", async ({ page }) => {
  const chart = await openChart(page)
  const canvas = page.getByTestId("chart-canvas")
  const ann = chart.getByRole("button", { name: "Ann, Designer" })
  await ann.click()
  await expect(page.getByRole("complementary", { name: "Ann" })).toBeVisible()
  await expect.poll(() => page.getByTestId("chart-viewport").evaluate((el) => el.clientWidth)).toBeLessThan(900)
  const byMouse = await canvas.getAttribute("data-transform")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("complementary")).toHaveCount(0)
  await ann.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("complementary", { name: "Ann" })).toBeVisible()
  await expect(canvas).toHaveAttribute("data-transform", byMouse!)
  await page.keyboard.press("Escape")
  // Zoomed in, the viewer's own view: the panel takes room from the right, and the selected card stays in view.
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom in" }).click()
  const minh = chart.getByRole("button", { name: "Minh, Engineer" })
  await ann.focus()
  await page.keyboard.press("End")
  await expect(minh).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("complementary", { name: "Minh" })).toBeVisible()
  const inView = async () => {
    const v = (await page.getByTestId("chart-viewport").boundingBox())!
    const b = (await minh.boundingBox())!
    return b.x >= v.x && b.x + b.width <= v.x + v.width
  }
  await expect.poll(inView).toBe(true)
})

test("a sideways wheel pans; a trackpad pinch (the wheel with Ctrl) zooms harder than the wheel", async ({ page }) => {
  await openChart(page)
  const box = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const [k0, x0, y0] = await transform(page)
  await page.mouse.wheel(120, 0)
  await expect.poll(async () => (await transform(page))[1]).toBeCloseTo(x0 - 120, 0)
  expect((await transform(page))[0]).toBe(k0)
  expect((await transform(page))[2]).toBe(y0)
  await page.mouse.wheel(0, -50)
  await expect.poll(async () => (await transform(page))[0]).toBeGreaterThan(k0)
  const [k1] = await transform(page)
  expect(k1).toBeLessThan(k0 * 1.2)
  await page.keyboard.down("Control")
  await page.mouse.wheel(0, -30)
  await page.keyboard.up("Control")
  await expect.poll(async () => (await transform(page))[0]).toBeGreaterThan(k1 * 1.3)
})

test("two pointers moving apart zoom in", async ({ page }) => {
  await openChart(page)
  const [before] = await transform(page)
  // Playwright has no multi-touch mouse: send the pointer events a two-finger pinch makes.
  await page.getByTestId("chart-viewport").evaluate((el) => {
    const r = el.getBoundingClientRect()
    const send = (type: string, id: number, x: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: r.left + x, clientY: r.top + 100, bubbles: true, pointerType: "touch" }))
    send("pointerdown", 1, 200)
    send("pointerdown", 2, 300)
    send("pointermove", 2, 400)
    send("pointerup", 1, 200)
    send("pointerup", 2, 400)
  })
  expect((await transform(page))[0]).toBeCloseTo(Math.min(2, before * 2), 2)
})

test("a branch closes from its card and shows totals; clicking a card opens the side panel", async ({ page }) => {
  const chart = await openChart(page)
  const toggle = chart.getByRole("button", { name: "Lead's branch", exact: true })
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(chart.getByRole("button", { name: "Lead, Tech lead" })).toContainText("3 people")
  // The branch button sits below the totals line, not over it.
  const totals = (await chart.getByRole("button", { name: "Lead, Tech lead" }).getByTestId("totals").boundingBox())!
  expect(totals.y + totals.height).toBeLessThanOrEqual((await toggle.boundingBox())!.y + 1)
  await expect(chart.getByRole("button", { name: "Kai, Engineer" })).toHaveCount(0)
  await expect(chart.locator("svg path[data-edge]")).toHaveCount(2)
  // The same description as the list's row.
  await expect(chart.getByRole("button", { name: "Lead, Tech lead" })).toHaveAccessibleDescription(
    "waiting in this branch · 1 card for you · $0.00 · 3 people · 1 busy · 2 waiting · 2 for you · $0.42 +1 unpriced")
  await chart.getByRole("button", { name: "Lead's branch", exact: true }).click()
  await expect(chart.locator("svg path[data-edge]")).toHaveCount(4)
  await chart.getByRole("button", { name: "Ann, Designer" }).click()
  await expect(page.getByRole("complementary", { name: "Ann" })).toBeVisible()
  await expect(chart.getByRole("button", { name: "Ann, Designer" })).toHaveAttribute("aria-current", "true")
  await expect(chart.locator("[aria-current=true]")).toHaveCount(1)
})

test("a new layout keeps the lines that are still drawn", async ({ page }) => {
  const chart = await openChart(page)
  const line = chart.locator('path[data-edge="ngocbh>ann"]')
  await line.evaluate((el) => ((el as any).__kept = true))
  const d = await line.getAttribute("d")
  await chart.getByRole("button", { name: "Lead's branch", exact: true }).click()
  await expect(chart.locator("svg path[data-edge]")).toHaveCount(2)
  await expect(line).not.toHaveAttribute("d", d!) // the cards moved
  expect(await line.evaluate((el) => (el as any).__kept)).toBe(true)
})

test("the branch choice is the list's: closed in the chart, closed in the list", async ({ page }) => {
  const chart = await openChart(page)
  await chart.getByRole("button", { name: "Lead's branch", exact: true }).click()
  await page.getByRole("radio", { name: "List" }).click()
  await expect(page.getByRole("treeitem", { name: /Lead/ })).toHaveAttribute("aria-expanded", "false")
})

test("the cards are one tab stop; arrow keys move up, down and across", async ({ page }) => {
  const chart = await openChart(page)
  const card = (name: string) => chart.getByRole("button", { name, exact: true })
  await expect(chart.locator('[data-card] [aria-describedby][tabindex="0"]')).toHaveCount(1)
  await page.getByRole("radio", { name: "Chart" }).focus()
  await page.keyboard.press("Tab")
  await expect(card("Ngoc, CEO")).toBeFocused()
  for (const [key, name] of [
    ["ArrowDown", "Ann, Designer"],
    ["ArrowRight", "Lead, Tech lead"],
    ["ArrowDown", "Kai, Engineer"],
    ["ArrowRight", "Minh, Engineer"],
    ["ArrowUp", "Lead, Tech lead"],
    ["ArrowUp", "Ngoc, CEO"],
    ["End", "Minh, Engineer"],
    ["Home", "Ngoc, CEO"],
  ]) {
    await page.keyboard.press(key)
    await expect(card(name)).toBeFocused()
  }
  await expect(card("Ngoc, CEO")).toHaveAttribute("tabindex", "0")
  // Tab goes on to the focused card's branch button, then past the other cards.
  await page.keyboard.press("Tab")
  await expect(chart.getByRole("button", { name: "Ngoc's branch", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(chart.getByRole("button", { name: "Zoom in" })).toBeFocused()
})

test("a card that takes focus off screen is panned into view", async ({ page }) => {
  const chart = await openChart(page)
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Zoom in" }).click()
  await chart.getByRole("button", { name: "Ngoc, CEO" }).focus()
  const view = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.keyboard.press("End") // Minh, far to the right and below at this zoom
  const minh = (await chart.getByRole("button", { name: "Minh, Engineer" }).boundingBox())!
  expect(minh.x).toBeGreaterThanOrEqual(view.x)
  expect(minh.x + minh.width).toBeLessThanOrEqual(view.x + view.width)
  expect(minh.y + minh.height).toBeLessThanOrEqual(view.y + view.height)
  // The viewport itself never scrolls: the canvas's transform does the moving.
  expect(await page.getByTestId("chart-viewport").evaluate((el) => [el.scrollLeft, el.scrollTop])).toEqual([0, 0])
})

test("Enter on a card opens the side panel; Escape brings focus back to the card", async ({ page }) => {
  const chart = await openChart(page)
  await chart.getByRole("button", { name: "Kai, Engineer" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("complementary", { name: "Kai" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("complementary")).toHaveCount(0)
  await expect(chart.getByRole("button", { name: "Kai, Engineer" })).toBeFocused()
  await expect(chart.getByRole("button", { name: "Kai, Engineer" })).toHaveAttribute("tabindex", "0")
})

test("when the focused card goes away, focus moves to the nearest card above it that's still there", async ({ page, request }) => {
  const chart = await openChart(page)
  await chart.getByRole("button", { name: "Kai, Engineer" }).focus()
  const next = SHA.replace(/^0/, "f")
  const people = acme().view.people.map((p) => (p.handle === "kai" ? { ...p, manager: "ghost" } : p))
  await request.post("/__fixture/set", { data: { view: { sha: next, people } } })
  await request.post("/__fixture/emit", { data: { event: { type: "company.updated", data: { sha: next } } } })
  await expect(chart.getByRole("button", { name: "Kai, Engineer" })).toHaveCount(0) // unplaced now
  await expect(chart.getByRole("button", { name: "Lead, Tech lead" })).toBeFocused()
  await expect(chart.getByRole("button", { name: "Lead, Tech lead" })).toHaveAttribute("tabindex", "0")
})

test("a live update keeps the focused card's element", async ({ page, request }) => {
  const chart = await openChart(page)
  const ann = chart.getByRole("button", { name: "Ann, Designer" })
  await ann.focus()
  await ann.evaluate((el) => ((el as any).__kept = true))
  await request.post("/__fixture/emit", {
    data: { event: { type: "session.updated", data: { ...acme().sessions[1], id: "S-ann", person: "ann", status: "busy", updated_at: "2026-10-19T12:00:00.000Z" } } },
  })
  await expect(ann.getByTestId("status")).toHaveAttribute("data-status", "busy")
  await expect(ann).toBeFocused()
  expect(await ann.evaluate((el) => (el as any).__kept)).toBe(true)
})

test("By team draws team headers over their members, with copies muted", async ({ page }) => {
  const chart = await openChart(page)
  await page.getByText("By team", { exact: true }).click()
  await expect(chart.getByRole("group", { name: "ENG", exact: true })).toBeVisible()
  await expect(chart.getByRole("group", { name: "No team", exact: true })).toBeVisible()
  await expect(chart.locator('[data-muted="true"]')).toHaveCount(1) // Minh's copy under OPS
  await expect(chart.locator('[data-muted="true"]').getByRole("button", { name: "Minh, Engineer" })).toBeVisible()
  await chart.getByRole("button", { name: "OPS's branch", exact: true }).click()
  await expect(chart.locator('[data-muted="true"]')).toHaveCount(0)
})

test("the chart is the desktop default, and the choice of view is remembered", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("figure", { name: "Acme org chart" })).toBeVisible()
  await expect(page.getByRole("radio", { name: "Chart" })).toHaveAttribute("aria-checked", "true")
  await page.getByRole("radio", { name: "List" }).click()
  await page.reload()
  await expect(page.getByRole("tree", { name: "Acme" })).toBeVisible()
  await page.getByRole("radio", { name: "Chart" }).click()
  await page.reload()
  await expect(page.getByRole("figure", { name: "Acme org chart" })).toBeVisible()
})

test("phones get the list, with no chart", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await expect(page.getByRole("tree", { name: "Acme" })).toBeVisible()
  await expect(page.getByRole("figure")).toHaveCount(0)
})

test("a wide company opens readable on its CEO; Fit brings every card into view", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { view: wide(60) } })
  const chart = await openChart(page)
  const within = async (name: string | RegExp) => {
    const v = (await page.getByTestId("chart-viewport").boundingBox())!
    const b = (await chart.getByRole("button", { name }).first().boundingBox())!
    return b.x >= v.x - 1 && b.x + b.width <= v.x + v.width + 1 && b.y >= v.y - 1 && b.y + b.height <= v.y + v.height + 1
  }
  expect((await transform(page))[0]).toBeGreaterThanOrEqual(0.6)
  expect(await within("Ngoc, CEO")).toBe(true)
  await page.getByRole("button", { name: "Fit" }).click()
  expect((await transform(page))[0]).toBeLessThan(0.6)
  const view = (await page.getByTestId("chart-viewport").boundingBox())!
  const cards = chart.getByRole("button", { name: /^Agent / })
  await expect(cards).toHaveCount(60)
  for (const card of [cards.first(), cards.last(), chart.getByRole("button", { name: "Ngoc, CEO" })]) {
    const b = (await card.boundingBox())!
    expect(b.x).toBeGreaterThanOrEqual(view.x - 1)
    expect(b.x + b.width).toBeLessThanOrEqual(view.x + view.width + 1)
    expect(b.y).toBeGreaterThanOrEqual(view.y - 1)
    expect(b.y + b.height).toBeLessThanOrEqual(view.y + view.height + 1)
  }
  // Keyboard focus on a card too small to read zooms in to read it, and shows it.
  await page.getByRole("radio", { name: "Chart" }).focus()
  await page.keyboard.press("Tab")
  await expect(chart.getByRole("button", { name: "Ngoc, CEO" })).toBeFocused()
  expect((await transform(page))[0]).toBeGreaterThanOrEqual(0.6)
  expect(await within("Ngoc, CEO")).toBe(true)
  await page.keyboard.press("End")
  expect(await within("Agent 59, Worker")).toBe(true)
})

test("a few hundred people draw, pan and zoom", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { view: wide(300) } })
  const chart = await openChart(page)
  await expect(chart.getByRole("button", { name: /^Agent / })).toHaveCount(300)
  const view = (await page.getByTestId("chart-viewport").boundingBox())!
  const started = Date.now()
  await page.mouse.move(view.x + 20, view.y + 20)
  await page.mouse.down()
  await page.mouse.move(view.x + 220, view.y + 20, { steps: 20 })
  await page.mouse.up()
  await page.mouse.wheel(0, -300)
  await expect.poll(async () => (await transform(page))[0]).toBeGreaterThan(0)
  expect(Date.now() - started).toBeLessThan(5000)
})
