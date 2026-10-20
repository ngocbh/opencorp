import { expect, test } from "@playwright/test"
import { acme, card, person, session, SHA } from "./company"

test.beforeEach(async ({ request, page }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
  await page.goto("/")
  await page.getByRole("radio", { name: "List" }).click()
})

const row = (page: import("@playwright/test").Page, name: RegExp | string) => page.getByRole("treeitem", { name })
const problems = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "Problems in the company repo" })

test("a tree named after the company; the CEO and level one start open", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Acme" })
  await expect(tree.getByRole("treeitem", { name: /Ngoc/ })).toHaveAttribute("aria-expanded", "true")
  await expect(tree.getByRole("treeitem", { name: /Lead/ })).toHaveAttribute("aria-expanded", "true")
  await expect(row(page, /Lead/)).toHaveAttribute("aria-level", "2")
  await expect(row(page, /Minh/)).toHaveAttribute("aria-level", "3")
  await expect(row(page, /Ann/)).not.toHaveAttribute("aria-expanded") // a leaf
})

test("a row shows status, needs you, cost and +n unpriced", async ({ page }) => {
  await expect(row(page, /Kai/).getByTestId("status")).toHaveAttribute("data-status", "waiting")
  await expect(row(page, /Kai/).getByTestId("needs-you")).toHaveText("1")
  await expect(row(page, /Kai/).getByTestId("cost")).toHaveText("$0.42")
  await expect(row(page, /Minh/).getByTestId("cost")).toHaveText("$0.00 +1 unpriced")
  await expect(row(page, /Minh/).getByTestId("status")).toHaveAttribute("data-status", "busy")
  await expect(row(page, /Ann/).getByTestId("status")).toHaveAttribute("data-status", "away")
  await expect(row(page, /Ann/).getByTestId("needs-you")).toHaveCount(0)
})

test("a branch closes with its chevron, shows totals while closed, and stays closed across reloads", async ({ page }) => {
  await row(page, /Lead/).getByTestId("toggle").click()
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "false")
  await expect(row(page, /Kai/)).toHaveCount(0)
  await expect(row(page, /Lead/)).toContainText("3 people · 1 busy · 2 waiting")
  await expect(row(page, /Lead/)).toContainText("$0.42 +1 unpriced")
  await page.reload()
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "false")
})

test("a closed branch's dot shows the most urgent status in it, marked as the branch's", async ({ page }) => {
  await expect(row(page, /Ngoc/).getByTestId("status")).toHaveAttribute("data-status", "away")
  await row(page, /Ngoc/).getByTestId("toggle").click()
  await expect(row(page, /Ngoc/).getByTestId("status")).toHaveAttribute("data-status", "waiting")
  await expect(row(page, /Ngoc/).getByTestId("status")).toHaveAttribute("data-branch", "true")
  await expect(row(page, /Ngoc/).getByTestId("status")).toContainText("waiting in this branch")
})

test("a row's description gives what its name leaves out: status, cards for you, cost, totals", async ({ page }) => {
  await expect(row(page, /Kai/)).toHaveAccessibleName("Kai, Engineer")
  await expect(row(page, /Kai/)).toHaveAccessibleDescription("waiting · 1 card for you · $0.42")
  await expect(row(page, /Ann/)).toHaveAccessibleDescription("away · $0.00")
  await row(page, /Lead/).getByTestId("toggle").click()
  await expect(row(page, /Lead/)).toHaveAccessibleDescription(
    "waiting in this branch · 1 card for you · $0.00 · 3 people · 1 busy · 2 waiting · 2 for you · $0.42 +1 unpriced")
})

test("a leaf shows no branch totals", async ({ page }) => {
  await expect(row(page, /Kai/).getByTestId("cost")).toHaveText("$0.42")
  await expect(row(page, /Ann/)).not.toContainText("person")
  await expect(row(page, /Kai/)).not.toContainText("person")
})

test("a branch that opened for a card stays open once the card is answered", async ({ page, request }) => {
  const data = acme()
  await request.post("/__fixture/set", {
    data: {
      view: { people: [...data.view.people, person("eve", "Eve", "agent", "Intern", "kai")] },
      sessions: [...data.sessions, session("S-eve", "eve", "idle", { opened_by: "ngocbh" })],
      questions: [...data.questions, card("Q-eve", "S-eve", "eve")],
    },
  })
  await page.reload()
  await page.getByRole("radio", { name: "List" }).click()
  await expect(row(page, /Kai/)).toHaveAttribute("aria-expanded", "true")
  await request.post("/__fixture/emit", {
    data: { event: { type: "question.updated", data: card("Q-eve", "S-eve", "eve", { status: "answered", updated_at: "2026-10-19T12:00:00.000Z" }) } },
  })
  await expect(row(page, /Eve/).getByTestId("status")).toHaveAttribute("data-status", "idle")
  await expect(row(page, /Kai/)).toHaveAttribute("aria-expanded", "true")
})

test("arrow keys move, open and close, as the tree pattern says", async ({ page }) => {
  await row(page, /Ngoc/).focus()
  await page.keyboard.press("ArrowDown")
  await expect(row(page, /Ann/)).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(row(page, /Lead/)).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "false")
  await expect(row(page, /Lead/)).toBeFocused() // the row kept its element
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowRight")
  await expect(row(page, /Kai/)).toBeFocused()
  await expect(row(page, /Kai/)).toHaveAttribute("tabindex", "0")
  await page.keyboard.press("ArrowLeft")
  await expect(row(page, /Lead/)).toBeFocused()
  await page.keyboard.press("End")
  await expect(row(page, /Minh/)).toBeFocused()
  await page.keyboard.press("Home")
  await expect(row(page, /Ngoc/)).toBeFocused()
})

test("the toolbar names the company", async ({ page }) => {
  await expect(page.getByRole("main").getByRole("heading", { name: "Acme", level: 2 })).toBeVisible()
})

test("when the focused row goes away, focus moves to the nearest row above it that's still there", async ({ page, request }) => {
  await row(page, /Kai/).focus()
  const next = SHA.replace(/^0/, "f")
  const people = acme().view.people.map((p) => (p.handle === "kai" ? { ...p, manager: "ghost" } : p))
  await request.post("/__fixture/set", { data: { view: { sha: next, people } } })
  await request.post("/__fixture/emit", { data: { event: { type: "company.updated", data: { sha: next } } } })
  await expect(row(page, /Kai/)).toHaveCount(0) // unplaced now
  await expect(row(page, /Lead/)).toBeFocused()
  await expect(row(page, /Lead/)).toHaveAttribute("tabindex", "0")
})

test("search filters by name, handle or title, keeping the people above a match", async ({ page }) => {
  await page.getByRole("searchbox", { name: "Search people" }).fill("kai")
  await expect(row(page, /Kai/)).toBeVisible()
  await expect(row(page, /Lead/)).toBeVisible()
  await expect(row(page, /Ann/)).toHaveCount(0)
  await page.getByRole("searchbox", { name: "Search people" }).fill("designer")
  await expect(row(page, /Ann/)).toBeVisible()
  await page.getByRole("searchbox", { name: "Search people" }).fill("")
  await expect(row(page, /Minh/)).toBeVisible()
})

test("closing a branch while searching works for that search only, and left then reaches the parent", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search people" })
  await search.fill("kai")
  await row(page, /Lead/).focus()
  await page.keyboard.press("ArrowLeft")
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "false")
  await expect(row(page, /Kai/)).toHaveCount(0)
  await page.keyboard.press("ArrowLeft")
  await expect(row(page, /Ngoc/)).toBeFocused()
  await search.fill("ka") // a new search starts with every kept branch open
  await expect(row(page, /Kai/)).toBeVisible()
  await search.fill("")
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "true")
  await page.reload()
  await page.getByRole("radio", { name: "List" }).click()
  await expect(row(page, /Lead/)).toHaveAttribute("aria-expanded", "true") // nothing was saved
})

test("the group filter dims everyone outside the group", async ({ page }) => {
  await page.getByRole("combobox", { name: "Group" }).selectOption("ops")
  await expect(row(page, /Kai/)).toHaveAttribute("data-dimmed", "true")
  await expect(row(page, /Minh/)).toHaveAttribute("data-dimmed", "false")
  await page.getByRole("combobox", { name: "Group" }).selectOption("")
  await expect(row(page, /Kai/)).toHaveAttribute("data-dimmed", "false")
})

test("By team groups people under their teams, muted after their first, with No team last", async ({ page }) => {
  await page.getByText("By team", { exact: true }).click() // the switch's label; its input is visually hidden
  await expect(page.getByRole("switch", { name: "By team" })).toBeChecked()
  await expect(page.getByRole("treeitem", { name: "ENG", exact: true })).toHaveAttribute("aria-level", "1")
  await expect(page.getByRole("treeitem", { name: "OPS", exact: true })).toHaveAttribute("aria-level", "2")
  await expect(page.getByRole("treeitem", { name: "No team", exact: true })).toBeVisible()
  await expect(page.locator('[role=treeitem][data-muted="true"]')).toHaveAttribute("aria-label", "Minh, Engineer")
})

test("the cost window refetches costs and is remembered", async ({ page, request }) => {
  const costs = async () => (await (await request.get("/__fixture/log")).json()).costs as string[]
  await expect(page.getByRole("radio", { name: "Today" })).toHaveAttribute("aria-checked", "true")
  await page.getByRole("radio", { name: "7 days" }).click()
  await expect(page.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true")
  await expect.poll(async () => (await costs()).length).toBe(2)
  const [today, week] = await costs()
  expect(Date.parse(week)).toBeLessThan(Date.parse(today))
  await page.reload()
  await expect(page.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true")
})

test("Chart, List and Source on a desktop; phones get the list, with List and Source", async ({ page }) => {
  await expect(page.getByRole("radiogroup", { name: "View" }).getByRole("radio")).toHaveText(["Chart", "List", "Source"])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByRole("tree", { name: "Acme" })).toBeVisible()
  await expect(page.getByRole("radiogroup", { name: "View" }).getByRole("radio")).toHaveText(["List", "Source"])
})

test("a radio group is one tab stop, and arrow keys move its choice", async ({ page }) => {
  const today = page.getByRole("radio", { name: "Today" })
  await expect(page.getByRole("radiogroup", { name: "Cost window" }).locator("[tabindex='0']")).toHaveCount(1)
  await today.focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("radio", { name: "7 days" })).toBeFocused()
  await expect(page.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true")
  await page.keyboard.press("ArrowLeft")
  await page.keyboard.press("ArrowLeft")
  await expect(page.getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "true")
})

test("unplaced people, the issue banner and the doctor pointer; banners aren't alerts", async ({ page }) => {
  const unplaced = page.getByRole("region", { name: "Unplaced" })
  await expect(unplaced).toContainText("Zoe")
  await expect(unplaced).toContainText("`opencorp doctor` names unknown managers and cycles")
  await expect(problems(page)).toContainText("people/bad/person.yaml: kind: isn't an allowed value")
  await expect(page.getByRole("alert")).toHaveCount(0) // a broken file isn't news to interrupt a screen reader with
})

test("a CEO with a manager stays at the top, with a banner", async ({ page, request }) => {
  const people = acme().view.people.map((p) => (p.handle === "ngocbh" ? { ...p, manager: "ann" } : p))
  await request.post("/__fixture/set", { data: { view: { people } } })
  await page.reload()
  await expect(problems(page).getByText(/company\.ceo_has_manager/)).toBeVisible()
  await expect(row(page, /Ngoc/)).toHaveAttribute("aria-level", "1")
})

test("no readable company.yaml: a banner, and everyone without a manager at the top", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { view: { company: null } } })
  await page.reload()
  await expect(problems(page).getByText(/company\.yaml is missing/)).toBeVisible()
  await expect(page.getByRole("tree", { name: "Company" })).toBeVisible()
})

/** Emits `events`, then a status change for Ann, and waits for it: the app has applied everything before it. */
async function emitAndSettle(page: import("@playwright/test").Page, request: import("@playwright/test").APIRequestContext,
  events: { type: string; data: object }[]) {
  const at = new Date().toISOString()
  for (const event of [...events, { type: "session.updated", data: session("S-ann", "ann", "busy", { updated_at: at }) }])
    await request.post("/__fixture/emit", { data: { event } })
  await expect(row(page, /Ann/).getByTestId("status")).toHaveAttribute("data-status", "busy")
}

const workItemReads = async (request: import("@playwright/test").APIRequestContext) =>
  (await (await request.get("/__fixture/log")).json()).workItems as string[]

test("an ask_manager card counts for its work item's assignee, read once", async ({ page, request }) => {
  await expect(row(page, /Lead/).getByTestId("needs-you")).toHaveText("1")
  const again = card("Q-lead", "S-lead", "lead", { source: "ask_manager", work_item_id: "W1", updated_at: "2026-10-19T11:00:00.000Z" })
  await emitAndSettle(page, request, [{ type: "question.updated", data: again }])
  expect(await workItemReads(request)).toEqual(["W1"])
})

test("a work item that doesn't exist is asked for once", async ({ page, request }) => {
  const gone = card("Q-lead", "S-lead", "lead", { source: "ask_manager", work_item_id: "W-gone" })
  await request.post("/__fixture/set", { data: { questions: [acme().questions[0], gone] } })
  await page.reload()
  const gones = async () => (await workItemReads(request)).filter((id) => id === "W-gone").length
  await expect.poll(gones).toBe(1)
  await emitAndSettle(page, request, [{ type: "question.updated", data: { ...gone, updated_at: "2026-10-19T11:00:00.000Z" } }])
  expect(await gones()).toBe(1)
})

test("a live status change shows without a reload", async ({ page, request }) => {
  await request.post("/__fixture/emit", {
    data: { event: { type: "session.updated", data: session("S-ann", "ann", "busy", { updated_at: "2026-10-19T12:00:00.000Z" }) } },
  })
  await expect(row(page, /Ann/).getByTestId("status")).toHaveAttribute("data-status", "busy")
})

test("a skeleton shows until the first snapshot", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { delay: { "/api/company": 1000 } } })
  await page.reload()
  await expect(page.locator("[aria-busy=true]")).toBeVisible()
  await expect(page.getByRole("tree", { name: "Acme" })).toBeVisible()
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0)
})

test("keyboard focus shows on the switch and the radio groups; the chevron is a 24px target", async ({ page }) => {
  const box = await row(page, /Lead/).getByTestId("toggle").boundingBox()
  expect([box!.width >= 24, box!.height >= 24]).toEqual([true, true])
  await page.getByRole("combobox", { name: "Group" }).focus()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("switch", { name: "By team" })).toBeFocused()
  const ring = (el: Element) => getComputedStyle(el).boxShadow
  expect(await page.locator("[data-testid=switch-control]").evaluate(ring)).not.toBe("none")
  await page.keyboard.press("Tab")
  await expect(page.getByRole("radio", { name: "Today" })).toBeFocused()
  expect(await page.getByRole("radio", { name: "Today" }).evaluate(ring)).not.toBe("none")
  expect(await page.getByRole("radiogroup", { name: "Cost window" }).evaluate((el) => getComputedStyle(el).overflow)).toBe("visible")
})

test("on a phone a row drops its group chips and totals", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(row(page, /Minh/).getByText("OPS")).toBeHidden()
  await row(page, /Lead/).getByTestId("toggle").click()
  await expect(row(page, /Lead/).getByTestId("totals")).toBeHidden()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(row(page, /Lead/).getByTestId("totals")).toBeVisible()
})
