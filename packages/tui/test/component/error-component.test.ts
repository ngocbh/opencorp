import { expect, test } from "bun:test"
import { buildIssueURL } from "../../src/component/error-component"

test("crash report links to the OpenCorp issue tracker", () => {
  const url = buildIssueURL("boom", "Error: boom\n    at x")
  expect(url.origin + url.pathname).toBe("https://github.com/ngocbh/opencorp/issues/new")
  expect(url.searchParams.get("title")).toBe("TUI crash: boom")
  expect(url.searchParams.get("body")).toContain("Error: boom")
})

test("crash report truncates long stacks to fit the URL budget", () => {
  const url = buildIssueURL("boom", "x".repeat(20_000))
  expect(url.toString().length).toBeLessThanOrEqual(6000)
  expect(url.searchParams.get("body")).toContain("(truncated)")
})
