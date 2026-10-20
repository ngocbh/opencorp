import { expect, test } from "bun:test"
import { chooseView, pathOf, sourceHref } from "../src/company/address"

test("Source when the address says so, on any screen; it wins over the saved choice", () => {
  expect(chooseView("source", true, "list")).toBe("source")
  expect(chooseView("source", false, null)).toBe("source")
  expect(chooseView(["source", "chart"], true, null)).toBe("source")
})

test("otherwise the saved choice on a desktop (the chart before the first), and the list on a phone", () => {
  expect(chooseView(undefined, true, null)).toBe("chart")
  expect(chooseView(undefined, true, "list")).toBe("list")
  expect(chooseView("chart", true, "list")).toBe("list") // only Source is in the address
  expect(chooseView(undefined, false, "chart")).toBe("list")
  expect(chooseView("grid", false, null)).toBe("list")
})

test("the address's path in the one path format: no leading or trailing slash, the root is empty", () => {
  expect(pathOf(undefined)).toBe("")
  expect(pathOf("")).toBe("")
  expect(pathOf("people/kai/person.yaml")).toBe("people/kai/person.yaml")
  expect(pathOf("/people/kai/")).toBe("people/kai")
  expect(pathOf(["people", "assets"])).toBe("people")
})

test("a path's address keeps its slashes readable and escapes the rest; the root leaves path out", () => {
  expect(sourceHref("")).toBe("/org?view=source")
  expect(sourceHref("people/kai/person.yaml")).toBe("/org?view=source&path=people/kai/person.yaml")
  expect(sourceHref("notes/a b&c#d+e.md")).toBe("/org?view=source&path=notes/a%20b%26c%23d%2Be.md")
  const back = new URL(sourceHref("notes/a b&c#d+e.md"), "http://x").searchParams.get("path")
  expect(back).toBe("notes/a b&c#d+e.md")
})
