import { expect, test, type Page } from "@playwright/test"
import { EXTRA_FILES, source, withFiles } from "./company"

test.beforeEach(async ({ request }) => void (await request.post("/__fixture/reset")))

/**
 * Collects the CSP violations a page reports, from the console and from securitypolicyviolation events. Call the
 * returned function before each navigation and at the end: the events are kept per document.
 */
async function watchCsp(page: Page) {
  const seen: string[] = []
  page.on("console", (m) => void (/content security policy/i.test(m.text()) && seen.push(m.text())))
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      ((window as any).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`),
    ),
  )
  return async () => {
    seen.push(...(await page.evaluate(() => (window as any).__csp?.splice(0) ?? [])))
    return seen
  }
}

test("the built app loads with no CSP violation", async ({ page }) => {
  const violations = await watchCsp(page)
  const response = await page.goto("/")
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'")
  await expect(page.getByRole("heading", { name: "Sign in to OpenCorp HQ" })).toBeVisible()
  // theme.js ran: a missing one is a 404, not a CSP violation.
  expect(await page.locator("html").getAttribute("data-theme")).toMatch(/^(light|dark)$/)
  expect(await violations()).toEqual([])
})

test("the sign-in form, its error and signing in with a password load with no CSP violation", async ({ page }) => {
  const violations = await watchCsp(page)
  await page.goto("/sign-in")
  await page.getByLabel("Handle").fill("ngocbh")
  await page.getByLabel("Password").fill("wrong one")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("alert")).toHaveText("Wrong handle or password.")
  await violations()
  await page.getByLabel("Password").fill("correct horse")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  expect(await violations()).toEqual([])
})

test("the sidebar's Sign out, and the sign-in page it lands on, load with no CSP violation", async ({ page }) => {
  const violations = await watchCsp(page)
  await page.goto("/sign-in")
  await page.getByLabel("Handle").fill("ngocbh")
  await page.getByLabel("Password").fill("correct horse")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  await page.getByRole("navigation", { name: "HQ" }).getByRole("button", { name: "Sign out" }).focus()
  await violations()
  await page.getByRole("navigation", { name: "HQ" }).getByRole("button", { name: "Sign out" }).click()
  await expect(page.getByRole("heading", { name: "Sign in to OpenCorp HQ" })).toBeVisible()
  expect(await violations()).toEqual([])
})

test("the sidebar on a desktop, and its Menu drawer on a phone, load with no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  const violations = await watchCsp(page)
  await page.goto("/")
  const nav = page.getByRole("navigation", { name: "HQ" })
  await expect(nav.getByRole("link", { name: "Org" })).toHaveAttribute("aria-current", "page")
  await nav.getByRole("link", { name: "Issues soon" }).hover()
  await nav.getByRole("link", { name: "Org" }).focus()
  await page.goto("/nowhere")
  await expect(page.getByText("There's no page here.")).toBeVisible()
  await violations()
  await page.setViewportSize({ width: 390, height: 844 })
  await nav.getByRole("button", { name: "Menu" }).click()
  await expect(nav.getByRole("link", { name: "Activity soon" })).toBeVisible()
  await page.keyboard.press("Escape")
  await nav.getByRole("button", { name: "Menu" }).click()
  await nav.getByRole("link", { name: "Org" }).click()
  await expect(page.getByRole("tree", { name: "Acme" })).toBeVisible()
  expect(await violations()).toEqual([])
})

test("pairing, the shell, the reconnecting banner and the blocked page load with no CSP violation", async ({ page, request }) => {
  const violations = await watchCsp(page)
  await page.goto("/pair#nope")
  await expect(page.getByRole("alert")).toBeVisible()
  await violations()
  await request.post("/__fixture/code", { data: { code: "from-ann-1234", issued_by: "ann" } })
  await page.goto("/pair#from-ann-1234")
  await expect(page.getByText("paired by @ann")).toBeVisible()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live")
  await request.post("/__fixture/drop", { data: { ms: 1000 } })
  await expect(page.getByText("Reconnecting to the office…")).toBeVisible()
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("live", { timeout: 15_000 })
  await violations()
  await request.post("/__fixture/set", { data: { health: { officeApi: "9.9.9+other" } } })
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("doesn't match the office")
  expect(await violations()).toEqual([])
})

test("the list, its toolbar, banners and Kobalte's switch load with no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true, delay: { "/api/company": 500 } } })
  const violations = await watchCsp(page)
  await page.goto("/")
  await expect(page.locator("[aria-busy=true]")).toBeVisible()
  await page.getByRole("radio", { name: "List" }).click()
  await expect(page.getByRole("region", { name: "Unplaced" })).toBeVisible()
  await page.getByRole("combobox", { name: "Group" }).selectOption("ops")
  await page.getByRole("radio", { name: "7 days" }).click()
  await page.getByRole("searchbox", { name: "Search people" }).fill("m")
  await page.getByRole("treeitem", { name: /Lead/ }).getByTestId("toggle").click()
  await page.getByText("By team", { exact: true }).click()
  await expect(page.getByRole("treeitem", { name: "ENG", exact: true })).toBeVisible()
  expect(await violations()).toEqual([])
})

test("the side panel, its live sessions and 'now doing', and the phone sheet load with no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  const violations = await watchCsp(page)
  await page.goto("/")
  await page.getByRole("radio", { name: "List" }).click()
  await page.getByRole("treeitem", { name: /Minh/ }).click()
  await expect(page.getByRole("complementary", { name: "Minh" })).toContainText("now doing: Fix the build")
  await page.getByRole("complementary", { name: "Minh" }).getByRole("button", { name: "Lead" }).click()
  await expect(page.getByRole("complementary", { name: "Lead" })).toContainText("Kai")
  await page.keyboard.press("Escape")
  await violations()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("treeitem", { name: /Ann/ }).click()
  await expect(page.getByRole("dialog", { name: "Ann" })).toBeVisible()
  expect(await violations()).toEqual([])
})

test("the chart, panned, zoomed, pinched, with a branch closed and By team, has no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  const violations = await watchCsp(page)
  await page.goto("/")
  const chart = page.getByRole("figure", { name: "Acme org chart" })
  await expect(chart.getByRole("button", { name: "Ngoc, CEO" })).toBeVisible()
  const box = (await page.getByTestId("chart-viewport").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 4 })
  await page.mouse.up()
  await page.mouse.wheel(0, -200)
  await page.getByRole("button", { name: "Zoom out" }).click()
  await chart.getByRole("button", { name: "Lead's branch", exact: true }).click()
  await expect(chart.getByRole("button", { name: "Lead, Tech lead" })).toContainText("3 people")
  await chart.getByRole("button", { name: "Ann, Designer" }).click()
  await expect(page.getByRole("complementary", { name: "Ann" })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.getByText("By team", { exact: true }).click()
  await expect(chart.getByRole("group", { name: "ENG", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Fit" }).click()
  expect(await violations()).toEqual([])
})

test("Source: the tree, every content state, Copy, a gone file and the phone pane, with no CSP violation", async ({ page, request, context }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const violations = await watchCsp(page)
  await page.goto("/")
  await page.getByRole("radio", { name: "Source" }).click()
  const tree = page.getByRole("tree", { name: "Files" })
  await tree.getByRole("treeitem", { name: "README.md" }).click()
  await page.getByRole("button", { name: "Copy" }).click()
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible()
  await tree.getByRole("treeitem", { name: "assets" }).focus()
  await page.keyboard.press("ArrowRight")
  for (const name of [".env", "big.csv", "keys.yaml", "logo.png"]) {
    await tree.getByRole("treeitem", { name }).click()
    await expect(page.getByTestId("source-pane").getByRole("note")).toBeVisible()
  }
  await tree.getByRole("treeitem", { name: "latest.md" }).click()
  await expect(page.getByText("Symlink to README.md.")).toBeVisible()
  await page.goto("/org?view=source&path=people/ngocbh/person.yaml")
  await expect(page.getByRole("note")).toContainText("Shown without devices")
  await page.goto("/org?view=source&path=people/nobody/person.yaml")
  await expect(page.getByTestId("gone")).toBeVisible()
  await violations()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/org?view=source&path=people")
  await page.getByRole("list", { name: "Entries" }).getByRole("link", { name: "kai" }).click()
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("kai")
  expect(await violations()).toEqual([])
})

test("Run Logs: the list, a fold, search with its suggestions and highlights, and the phone layout, with no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  const violations = await watchCsp(page)
  await page.goto("/runs")
  await page.getByRole("table", { name: "Runs" }).getByRole("button", { name: /runs? under/ }).first().click()
  const box = page.getByRole("combobox", { name: "Search runs" })
  await box.fill("is:failed foo:x flow:")
  await expect(page.getByRole("listbox", { name: "Suggestions" })).toBeVisible()
  await box.fill("is:failed 0001")
  await box.press("Enter")
  await violations()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/runs")
  await expect(page.getByRole("table", { name: "Runs" })).toBeVisible()
  expect(await violations()).toEqual([])
})

test("Run Logs on an office without its routes: the list, a run page and the panel, with no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true, noRuns: true } })
  const violations = await watchCsp(page)
  const message = "Run Logs aren't available on this office yet. Update and restart the office to see its runs."
  await page.goto("/runs")
  await expect(page.getByText(message)).toBeVisible()
  await violations()
  await page.goto("/runs/01JA1H00000000000000000005")
  await expect(page.getByText(message)).toBeVisible()
  await violations()
  await page.goto("/org")
  await page.getByRole("radio", { name: "List" }).click()
  await page.getByRole("treeitem", { name: /Kai/ }).click()
  await expect(page.getByRole("complementary", { name: "Kai" })).toContainText("Not available on this office yet")
  expect(await violations()).toEqual([])
})

test("Source's syntax colors: YAML, JSON, Markdown, a big file, hostile text and the dark theme, with no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true, source: withFiles(source(), EXTRA_FILES) } })
  const violations = await watchCsp(page)
  const pane = page.getByTestId("source-pane")
  for (const path of ["flows/hire.yaml", "flows/office.json", "README.md", "flows/scrubbed.yaml", "flows/big.yaml", "flows/hostile.md", "flows/hostile.txt"]) {
    await page.goto(`/org?view=source&path=${path}`)
    await expect(pane.getByTestId("line-text").first()).toBeVisible()
    await violations()
  }
  await expect(pane.getByTestId("line-text").first()).toHaveText("<script>window.__xss = 1</script>")
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/org?view=source&path=flows/hire.yaml")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect(pane.locator(".hljs-attr").first()).toHaveText("name:")
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined()
  expect(await violations()).toEqual([])
})

test("a run page: the header and the Timeline unfolded, older nodes, and the phone layout, with no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  const violations = await watchCsp(page)
  await page.goto("/runs/01JA1H00000000000000000005")
  const tree = page.getByRole("tree", { name: "Timeline" })
  await tree.getByRole("treeitem", { name: /^iteration chat#2/ }).first().click()
  await page.getByRole("button", { name: "Older nodes" }).click()
  await violations()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/runs/01JA1H00000000000000000005")
  await expect(tree).toBeVisible()
  expect(await violations()).toEqual([])
})

test("a run page: a node's detail, Raw with an opened record, and the phone sheet, with no CSP violation", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  const violations = await watchCsp(page)
  await page.goto("/runs/01JA1H00000000000000000005")
  const tree = page.getByRole("tree", { name: "Timeline" })
  await tree.getByRole("treeitem", { name: /^iteration chat#2/ }).first().click()
  await tree.getByRole("treeitem", { name: /chat#2\/reply.*succeeded/ }).click()
  await expect(page.getByRole("region", { name: "Node chat#2/reply" })).toContainText("Done.")
  await page.getByRole("tab", { name: "Raw" }).click()
  await page.getByRole("button", { name: "Load more records" }).click()
  await page.getByRole("button", { name: "Open the whole record" }).first().click()
  await expect(page.getByRole("list", { name: "Records" })).toContainText("…whole…")
  await violations()
  await page.keyboard.press("Escape") // else the open node becomes a sheet over the tabs
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("tab", { name: "Timeline" }).click()
  await page.getByRole("tree", { name: "Timeline" }).getByRole("treeitem", { name: /chat#3\/ask/ }).click()
  await expect(page.getByRole("dialog", { name: "Node chat#3/ask" })).toBeVisible()
  expect(await violations()).toEqual([])
})
