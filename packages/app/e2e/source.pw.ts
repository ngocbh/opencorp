import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { EXTRA_FILES, FLOW, HOSTILE, LONG_LINE, SHA, source, withFiles } from "./company"

const NEXT = SHA.replace(/^0/, "f")

test.beforeEach(async ({ request }) => {
  await request.post("/__fixture/reset")
  await request.post("/__fixture/set", { data: { signedIn: true } })
})

const tree = (page: Page) => page.getByRole("tree", { name: "Files" })
const item = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true })
const pane = (page: Page) => page.getByTestId("source-pane")
const lines = (page: Page) => pane(page).getByTestId("line-text")
const entries = (page: Page) => pane(page).getByRole("list", { name: "Entries" }).getByRole("listitem")
const gone = (page: Page) => pane(page).getByTestId("gone")
const note = (page: Page) => pane(page).getByRole("note")
const files = async (request: APIRequestContext) =>
  (await (await request.get("/__fixture/log")).json()).files as { at: string; path: string }[]
const apiCalls = async (request: APIRequestContext, path: string) =>
  ((await (await request.get("/__fixture/log")).json()).api as string[]).filter((p) => p === path).length

/** Moves the repo to commit NEXT, with `change` applied to its files, and tells the app as the office would. */
async function commit(request: APIRequestContext, change: (s: ReturnType<typeof source>) => void) {
  const s = source()
  change(s)
  s.tree.commit = { ...s.tree.commit, id: NEXT, subject: "Change the repo" }
  await request.post("/__fixture/set", { data: { view: { sha: NEXT }, source: { tree: s.tree, files: s.files } } })
  await request.post("/__fixture/emit", { data: { event: { type: "company.updated", data: { sha: NEXT } } } })
}

test("Source shows the tree, folders first, and opens a file with line numbers", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("radiogroup", { name: "View" }).getByRole("radio")).toHaveText(["Chart", "List", "Source"])
  await page.getByRole("radio", { name: "Source" }).click()
  await expect(page).toHaveURL(/\/org\?view=source$/)
  await expect(tree(page).getByRole("treeitem")).toHaveText(["assets", "people", "vendor", "company.yaml", "latest.md", "README.md"])
  await expect(page.getByTestId("commit")).toHaveText("0123456 Add Kai · Ngoc · 2 hours ago")
  // The root's entries, in the same order.
  await expect(entries(page)).toHaveText(["assets", "people", "vendor", "company.yaml", "latest.md", "README.md"])
  await item(page, "README.md").click()
  await expect(page).toHaveURL(/\/org\?view=source&path=README\.md$/)
  await expect(lines(page)).toHaveText(["# Acme", "", "The company repo.", LONG_LINE])
  await expect(pane(page).getByTestId("line-number")).toHaveText(["1", "2", "3", "4"])
  await expect(item(page, "README.md")).toHaveAttribute("aria-selected", "true")
  await expect(note(page)).toHaveCount(0)
  // A row's name says what its hidden icon shows, for the types a name can't tell.
  await expect(item(page, "latest.md, symlink")).toBeVisible()
  await expect(item(page, "vendor")).toBeVisible()
  await item(page, "vendor").click()
  await expect(item(page, "yian, submodule")).toBeVisible()
})

test("a long line wraps, and Copy copies the text as shown", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/org?view=source&path=README.md")
  const long = lines(page).nth(3)
  await expect(long).toHaveText(LONG_LINE)
  const fits = await long.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().height > 30)
  expect(fits).toBe(true)
  await pane(page).getByRole("button", { name: "Copy" }).click()
  await expect(pane(page).getByRole("button", { name: "Copied" })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source().files["README.md"].text!)
})

test("the address loads directly, opens the path's folders, and survives a reload", async ({ page }) => {
  await page.goto("/org?view=source&path=people/kai/person.yaml")
  await expect(item(page, "people")).toHaveAttribute("aria-expanded", "true")
  await expect(item(page, "kai")).toHaveAttribute("aria-expanded", "true")
  await expect(item(page, "ngocbh")).toHaveAttribute("aria-expanded", "false")
  await expect(item(page, "person.yaml")).toHaveAttribute("aria-selected", "true")
  await expect(lines(page).first()).toHaveText("# Kai writes the code.")
  await expect(pane(page).getByRole("navigation", { name: "Breadcrumb" }).getByRole("listitem")).toHaveText([
    "Acme", "people", "kai", "person.yaml"])
  await page.reload()
  await expect(lines(page).first()).toHaveText("# Kai writes the code.")
  expect(new URL(page.url()).search).toBe("?view=source&path=people/kai/person.yaml")
})

test("opening entries pushes history and arrow keys don't; Back goes from Source to the chart", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("figure", { name: "Acme org chart" })).toBeVisible()
  await page.getByRole("radio", { name: "Source" }).click()
  await item(page, "people").click()
  await expect(page).toHaveURL(/path=people$/)
  await expect(item(page, "people")).toHaveAttribute("aria-expanded", "true")
  await expect(item(page, "people")).toBeFocused()
  await page.keyboard.press("ArrowDown") // kai
  await page.keyboard.press("ArrowDown") // lead
  await page.keyboard.press("ArrowDown") // ngocbh
  await expect(item(page, "ngocbh")).toBeFocused()
  await expect(page).toHaveURL(/path=people$/)
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/path=people\/ngocbh$/)
  await page.goBack()
  await expect(page).toHaveURL(/path=people$/)
  await expect(entries(page)).toHaveText(["kai", "lead", "ngocbh"])
  await page.goBack()
  await expect(page).toHaveURL(/\/org\?view=source$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/org$/)
  await expect(page.getByRole("figure", { name: "Acme org chart" })).toBeVisible()
})

test("Chart and List stay in localStorage; only Source is in the address", async ({ page }) => {
  await page.goto("/")
  const saved = () => page.evaluate(() => localStorage.getItem("hq.view"))
  await page.getByRole("radio", { name: "List" }).click()
  await expect(page).toHaveURL(/\/org$/)
  await page.getByRole("radio", { name: "Source" }).click()
  await expect(tree(page)).toBeVisible()
  expect(await saved()).toBe('"list"')
  await page.getByRole("radio", { name: "Chart" }).click()
  await expect(page).toHaveURL(/\/org$/)
  await expect(page.getByRole("figure", { name: "Acme org chart" })).toBeVisible()
  expect(await saved()).toBe('"chart"')
  await page.goBack()
  await expect(tree(page)).toBeVisible()
  await expect(page.getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true")
  await page.goForward()
  await expect(page.getByRole("figure", { name: "Acme org chart" })).toBeVisible()
})

test("the people controls and Unplaced hide in Source", async ({ page }) => {
  await page.goto("/org?view=source")
  await expect(tree(page)).toBeVisible()
  await expect(page.getByRole("searchbox", { name: "Search people" })).toHaveCount(0)
  await expect(page.getByRole("combobox", { name: "Group" })).toHaveCount(0)
  await expect(page.getByRole("switch", { name: "By team" })).toHaveCount(0)
  await expect(page.getByRole("radiogroup", { name: "Cost window" })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Unplaced" })).toHaveCount(0)
  await expect(page.getByRole("radiogroup", { name: "View" })).toBeVisible()
})

test("each content state has its note", async ({ page }) => {
  const notes: [string, string][] = [
    ["people/ngocbh/person.yaml", "Shown without devices and password hash; comments and layout aren't kept."],
    ["assets/.env", "Hidden: may hold credentials."],
    ["assets/keys.yaml", "Hidden: holds a secret-named key."],
    ["assets/logo.png", "Binary file."],
    ["assets/big.csv", "Too large to show."],
    ["latest.md", "Symlink to README.md."],
    ["vendor/yian", "Submodule."],
  ]
  for (const [path, text] of notes) {
    await page.goto(`/org?view=source&path=${path}`)
    await expect(note(page)).toHaveText(text)
  }
  // Only a re-rendered file has text beside its note.
  await page.goto("/org?view=source&path=people/ngocbh/person.yaml")
  await expect(lines(page)).toHaveText(["handle: ngocbh", "name: Ngoc", "kind: human", "title: CEO", "manager: null"])
  await page.goto("/org?view=source&path=assets/keys.yaml")
  await expect(note(page)).toBeVisible()
  await expect(lines(page)).toHaveCount(0)
  await expect(pane(page).getByRole("button", { name: "Copy" })).toHaveCount(0)
})

test("a human's person.yaml shows no secret", async ({ page }) => {
  await page.goto("/org?view=source&path=people/ngocbh/person.yaml")
  await expect(lines(page).first()).toHaveText("handle: ngocbh")
  const text = await page.locator("body").innerText()
  expect(text).not.toContain("password_hash")
  expect(text).not.toContain("devices:")
  expect(text).not.toContain("$scrypt$")
  expect(text).not.toContain("token_sha256")
})

test("View source in the panel opens the person's folder and closes the panel", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("radio", { name: "List" }).click()
  await page.getByRole("treeitem", { name: /Kai/ }).click()
  await page.getByRole("complementary", { name: "Kai" }).getByRole("link", { name: "View source" }).click()
  await expect(page).toHaveURL(/\/org\?view=source&path=people\/kai$/)
  await expect(page.getByRole("complementary")).toHaveCount(0)
  await expect(entries(page)).toHaveText(["person.yaml", "profile.md"])
  await expect(item(page, "kai")).toHaveAttribute("aria-selected", "true")
  await expect(item(page, "kai")).toBeFocused() // the panel that had focus is gone
})

test("a new commit refetches the tree and the open file", async ({ page, request }) => {
  await page.goto("/org?view=source&path=people/kai/person.yaml")
  await expect(lines(page).first()).toHaveText("# Kai writes the code.")
  await commit(request, (s) => void (s.files["people/kai/person.yaml"] = { content: "text", text: "handle: kai\n" }))
  await expect(lines(page)).toHaveText(["handle: kai"])
  await expect(page.getByTestId("commit")).toContainText("f123456 Change the repo")
  expect((await files(request)).at(-1)).toEqual({ at: NEXT, path: "people/kai/person.yaml" })
})

test("a file gone from the latest commit says so and links its nearest folder", async ({ page, request }) => {
  await page.goto("/org?view=source&path=people/kai/profile.md")
  await expect(lines(page).first()).toHaveText("# Kai")
  await commit(request, (s) => {
    delete s.files["people/kai/profile.md"]
    s.tree.entries = s.tree.entries.filter((e) => e.path !== "people/kai/profile.md")
  })
  await expect(gone(page)).toHaveText("people/kai/profile.md isn't in the latest commit. Open people/kai.")
  await expect(lines(page)).toHaveCount(0)
  await gone(page).getByRole("link", { name: "people/kai" }).click()
  await expect(page).toHaveURL(/path=people\/kai$/)
  await expect(entries(page)).toHaveText(["person.yaml"])
})

test("a folder gone from the latest commit links the folder above it", async ({ page, request }) => {
  await page.goto("/org?view=source&path=people/kai")
  await expect(entries(page)).toHaveText(["person.yaml", "profile.md"])
  await commit(request, (s) => void (s.tree.entries = s.tree.entries.filter((e) => !e.path.startsWith("people/kai"))))
  await expect(gone(page)).toHaveText("people/kai isn't in the latest commit. Open people.")
  await expect(gone(page).getByRole("link", { name: "people" })).toBeVisible()
})

test("a gone path's breadcrumb links only the folders that exist", async ({ page }) => {
  await page.goto("/org?view=source&path=people/nobody/notes/a.md")
  await expect(gone(page)).toHaveText("people/nobody/notes/a.md isn't in the latest commit. Open people.")
  const crumbs = pane(page).getByRole("navigation", { name: "Breadcrumb" })
  await expect(crumbs.getByRole("listitem")).toHaveText(["Acme", "people", "nobody", "notes", "a.md"])
  await expect(crumbs.getByRole("link")).toHaveText(["Acme", "people"])
})

test("a 409 on a file reads the tree again once and retries at its commit", async ({ page, request }) => {
  await page.goto("/org?view=source")
  await expect(tree(page)).toBeVisible()
  // The office restarted at a new HEAD: the commit the app holds isn't served any more.
  const s = source()
  s.tree.commit.id = NEXT
  await request.post("/__fixture/set", { data: { source: { tree: s.tree, served: [] } } })
  await item(page, "README.md").click()
  await expect(lines(page).first()).toHaveText("# Acme")
  expect(await files(request)).toEqual([{ at: SHA, path: "README.md" }, { at: NEXT, path: "README.md" }])
  expect(await apiCalls(request, "/api/company/tree")).toBe(2)
})

test("a second 409 shows an error with Retry instead of reading again", async ({ page, request }) => {
  await page.goto("/org?view=source")
  await expect(tree(page)).toBeVisible()
  await request.post("/__fixture/set", { data: { source: { served: [], serve: false } } })
  await item(page, "README.md").click()
  const alert = pane(page).getByRole("alert")
  await expect(alert).toContainText("Couldn't read README.md. The office moved to a newer commit.")
  expect((await files(request)).length).toBe(2)
  await request.post("/__fixture/set", { data: { source: { serve: true } } })
  await alert.getByRole("button", { name: "Retry" }).click()
  await expect(lines(page).first()).toHaveText("# Acme")
})

test("a failed tree read shows an error with Retry, never a blank pane", async ({ page, request }) => {
  await request.post("/__fixture/set", { data: { fail: { "/api/company/tree": 500 } } })
  await page.goto("/org?view=source")
  const alert = page.getByRole("alert")
  await expect(alert).toContainText("Couldn't read the company repo's files")
  await request.post("/__fixture/set", { data: { fail: {} } })
  await alert.getByRole("button", { name: "Retry" }).click()
  await expect(tree(page)).toBeVisible()
})

test("a truncated listing says so, and a deep link past it still opens", async ({ page, request }) => {
  const s = source()
  s.tree.entries = s.tree.entries.filter((e) => !e.path.startsWith("people/"))
  s.tree.truncated = true
  s.tree.skipped = 2
  await request.post("/__fixture/set", { data: { source: { tree: s.tree } } })
  await page.goto("/org?view=source&path=people/kai/person.yaml")
  await expect(lines(page).first()).toHaveText("# Kai writes the code.")
  await expect(page.getByText(`Only the first ${s.tree.entries.length} entries are listed.`)).toBeVisible()
  await expect(page.getByText("2 paths aren't listed.")).toBeVisible()
  const n = s.tree.entries.length
  // A folder past the cap can't be told from a gone one, and a listed folder's entries may all be past it.
  await page.goto("/org?view=source&path=people/kai")
  await expect(gone(page)).toHaveText(`people/kai isn't in the first ${n} entries listed. Open people.`)
  await page.goto("/org?view=source&path=people")
  await expect(entries(page)).toHaveText([`Entries here are past the first ${n} listed.`])
})

test("a folder with no listed entries says so", async ({ page, request }) => {
  const s = source()
  s.tree.entries = s.tree.entries.filter((e) => !e.path.startsWith("people/"))
  await request.post("/__fixture/set", { data: { source: { tree: s.tree } } })
  await page.goto("/org?view=source&path=people")
  await expect(entries(page)).toHaveText(["Nothing here is listed."])
})

test("the tree's keys: arrows, Home and End, expand and collapse; only Enter opens", async ({ page }) => {
  await page.goto("/org?view=source")
  await item(page, "assets").focus()
  await page.keyboard.press("ArrowRight")
  await expect(item(page, "assets")).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("ArrowRight")
  await expect(item(page, ".env")).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(item(page, "assets")).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(item(page, "assets")).toHaveAttribute("aria-expanded", "false")
  await page.keyboard.press("End")
  await expect(item(page, "README.md")).toBeFocused()
  await page.keyboard.press("Home")
  await expect(item(page, "assets")).toBeFocused()
  await expect(page).toHaveURL(/\/org\?view=source$/)
  await expect(tree(page).locator("[tabindex='0']")).toHaveCount(1)
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/path=README\.md$/)
  await expect(lines(page).first()).toHaveText("# Acme")
  // A visible focus ring.
  await item(page, "README.md").focus()
  expect(await item(page, "README.md").evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none")
})

test("a phone gets List | Source, the folder list with a breadcrumb, and files at full width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await expect(page.getByRole("radiogroup", { name: "View" }).getByRole("radio")).toHaveText(["List", "Source"])
  await expect(page.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true")
  await page.getByRole("radio", { name: "Source" }).click()
  await expect(tree(page)).toHaveCount(0)
  await entries(page).getByRole("link", { name: "people" }).click()
  await entries(page).getByRole("link", { name: "kai" }).click()
  await entries(page).getByRole("link", { name: "person.yaml" }).click()
  await expect(page).toHaveURL(/path=people\/kai\/person\.yaml$/)
  await expect(lines(page).first()).toHaveText("# Kai writes the code.")
  await expect(pane(page)).toBeFocused() // the tapped link is gone; focus isn't left on the page
  const width = await pane(page).evaluate((el) => el.getBoundingClientRect().width)
  expect(width).toBeGreaterThan(370)
  const crumbs = pane(page).getByRole("navigation", { name: "Breadcrumb" })
  await expect(crumbs.getByRole("listitem")).toHaveText(["Acme", "people", "kai", "person.yaml"])
  await crumbs.getByRole("link", { name: "people" }).click()
  await expect(page).toHaveURL(/path=people$/)
  await expect(entries(page)).toHaveText(["kai", "lead", "ngocbh"])
  await crumbs.getByRole("link", { name: "Acme" }).click()
  await expect(page).toHaveURL(/\/org\?view=source$/)
  await page.getByRole("radio", { name: "List" }).click()
  await expect(page.getByRole("tree", { name: "Acme" })).toBeVisible()
  // A phone's choice isn't saved: a desktop still opens on the chart.
  expect(await page.evaluate(() => localStorage.getItem("hq.view"))).toBeNull()
})

test("on a phone, View source in the sheet opens the person's folder", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.getByRole("treeitem", { name: /Kai/ }).click()
  await page.getByRole("dialog", { name: "Kai" }).getByRole("link", { name: "View source" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page).toHaveURL(/path=people\/kai$/)
  await expect(entries(page)).toHaveText(["person.yaml", "profile.md"])
  await expect(pane(page)).toBeFocused()
})

/** Adds EXTRA_FILES (a flow, JSON, hostile text, a scrubbed file and a big one) under flows/. */
const addFlows = (request: APIRequestContext) =>
  request.post("/__fixture/set", { data: { source: withFiles(source(), EXTRA_FILES) } })
const color = (page: Page, selector: string) =>
  pane(page).locator(selector).first().evaluate((el) => getComputedStyle(el).color)
const header = (page: Page) => pane(page).getByTestId("file-header")

test("a YAML flow is colored like GitHub: keys, tags, strings, numbers, booleans and comments", async ({ page, request }) => {
  await addFlows(request)
  await page.goto("/org?view=source&path=flows/hire.yaml")
  await expect(lines(page)).toHaveText(FLOW.trimEnd().split("\n"))
  const code = pane(page).getByTestId("code")
  await expect(code.locator(".hljs-comment")).toHaveText(["# Hire an engineer."])
  await expect(code.locator(".hljs-attr").first()).toHaveText("name:")
  await expect(code.locator(".hljs-type")).toHaveText(["!str", "!Person"])
  await expect(code.locator(".hljs-number")).toHaveText(["2", "3"])
  await expect(code.locator(".hljs-literal")).toHaveText(["true"])
  await expect(code.locator(".hljs-string").first()).toHaveText("hire")
  // A block scalar runs over three lines: each line has its own span.
  await expect(lines(page).nth(11).locator(".hljs-string")).toHaveText("      Ask the lead first.")
  // GitHub light.
  expect(await color(page, ".hljs-attr")).toBe("rgb(0, 92, 197)")
  expect(await color(page, ".hljs-type")).toBe("rgb(215, 58, 73)")
  expect(await color(page, ".hljs-string")).toBe("rgb(3, 47, 98)")
  expect(await color(page, ".hljs-comment")).toBe("rgb(106, 115, 125)")
  // No inline style anywhere in the file view.
  await expect(pane(page).locator("[style]")).toHaveCount(0)
})

test("JSON and Markdown are colored too; an unknown file stays plain", async ({ page, request }) => {
  await addFlows(request)
  await page.goto("/org?view=source&path=flows/office.json")
  const code = pane(page).getByTestId("code")
  await expect(code.locator(".hljs-attr")).toHaveText(['"tcp"', '"port"', '"name"', '"dev_origins"'])
  await expect(code.locator(".hljs-literal")).toHaveText(["false", "null"])
  await expect(code.locator(".hljs-number")).toHaveText(["49380"])
  await expect(code.locator(".hljs-string")).toHaveText(['"HQ"'])
  await page.goto("/org?view=source&path=README.md")
  await expect(code.locator(".hljs-section")).toHaveText(["# Acme"])
  expect(await code.locator(".hljs-section").evaluate((el) => getComputedStyle(el).fontWeight)).toBe("700")
  await page.goto("/org?view=source&path=flows/hostile.txt")
  await expect(lines(page).first()).toHaveText("<script>window.__xss = 1</script>")
  await expect(code.locator("[class*=hljs-]")).toHaveCount(0)
  await expect(header(page)).toContainText("Text")
})

test("the dark theme follows the app's: GitHub dark colors", async ({ page, request }) => {
  await addFlows(request)
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/org?view=source&path=flows/hire.yaml")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect(pane(page).getByTestId("code").locator(".hljs-attr").first()).toHaveText("name:")
  expect(await color(page, ".hljs-attr")).toBe("rgb(121, 192, 255)")
  expect(await color(page, ".hljs-type")).toBe("rgb(255, 123, 114)")
  expect(await color(page, ".hljs-string")).toBe("rgb(165, 214, 255)")
  expect(await color(page, ".hljs-comment")).toBe("rgb(139, 148, 158)")
  // A saved light theme wins over the system's dark one.
  await page.evaluate(() => localStorage.setItem("hq.theme", "light"))
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await expect(pane(page).getByTestId("code").locator(".hljs-attr").first()).toHaveText("name:")
  expect(await color(page, ".hljs-attr")).toBe("rgb(0, 92, 197)")
})

test("the header bar has the name, language, line count, size and Copy; the gutter is muted", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await addFlows(request)
  await page.goto("/org?view=source&path=flows/hire.yaml")
  const bar = header(page)
  await expect(bar.getByTestId("file-name")).toHaveText("hire.yaml")
  await expect(bar.getByTestId("file-language")).toHaveText("YAML")
  await expect(bar.getByTestId("file-lines")).toHaveText("13 lines")
  await expect(bar.getByTestId("file-size")).toHaveText(`${FLOW.length} bytes`)
  await bar.getByRole("button", { name: "Copy" }).click()
  await expect(bar.getByRole("button", { name: "Copied" })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FLOW)
  // Line numbers sit in a gutter with its own background, and aren't copied with a selection.
  const number = pane(page).getByTestId("line-number").first()
  expect(await number.evaluate((el) => getComputedStyle(el).userSelect)).toBe("none")
  const gutter = pane(page).getByTestId("gutter")
  expect(await gutter.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)")
  const [g, n] = await Promise.all([gutter.boundingBox(), number.boundingBox()])
  expect(n!.x + n!.width).toBeLessThanOrEqual(g!.x + g!.width + 1)
  // The gutter runs the whole height of the code.
  const code = (await pane(page).getByTestId("code").boundingBox())!
  expect(g!.height).toBeGreaterThanOrEqual(code.height - 1)
})

test("a long line still wraps when colored", async ({ page, request }) => {
  const s = withFiles(source(), { "flows/long.yaml": { content: "text", text: `key: ${"word ".repeat(80)}end\n` } })
  await request.post("/__fixture/set", { data: { source: s } })
  await page.goto("/org?view=source&path=flows/long.yaml")
  const line = lines(page).first()
  await expect(line.locator(".hljs-attr")).toHaveText("key:")
  const fits = await line.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().height > 30)
  expect(fits).toBe(true)
})

test("a file over 512 KB isn't colored, and its header says so", async ({ page, request }) => {
  await addFlows(request)
  await page.goto("/org?view=source&path=flows/big.yaml")
  await expect(lines(page)).toHaveCount(1)
  await expect(pane(page).getByTestId("code").locator("[class*=hljs-]")).toHaveCount(0)
  await expect(header(page).getByTestId("file-language")).toHaveText("YAML, not colored (over 512 KB)")
  await expect(header(page).getByTestId("file-size")).toHaveText("512.0 KB")
})

test("(hidden) markers keep their own styling inside colored text", async ({ page, request }) => {
  await addFlows(request)
  await page.goto("/org?view=source&path=flows/scrubbed.yaml")
  await expect(lines(page)).toHaveText(["url: https://kai:(hidden)@example.com", "token: (hidden)"])
  const markers = pane(page).getByTestId("hidden-marker")
  await expect(markers).toHaveText(["(hidden)", "(hidden)"])
  expect(await markers.first().evaluate((el) => getComputedStyle(el).fontStyle)).toBe("italic")
  // Not the string color around it.
  expect(await markers.first().evaluate((el) => getComputedStyle(el).color)).not.toBe("rgb(3, 47, 98)")
  // The person.yaml note keeps its look beside colored text.
  await page.goto("/org?view=source&path=people/ngocbh/person.yaml")
  await expect(note(page)).toHaveText("Shown without devices and password hash; comments and layout aren't kept.")
  await expect(pane(page).getByTestId("code").locator(".hljs-attr").first()).toHaveText("handle:")
})

test("a file that looks like HTML or a template stays text, colored or plain", async ({ page, request }) => {
  await addFlows(request)
  const want = HOSTILE.trimEnd().split("\n")
  for (const path of ["flows/hostile.md", "flows/hostile.txt"]) {
    await page.goto(`/org?view=source&path=${path}`)
    await expect(lines(page)).toHaveText(want)
    await expect(pane(page).locator("script, img")).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined()
  }
})
