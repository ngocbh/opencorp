/** A page that sends a browser on to a link, and HTML escaping. */
import { expect, test } from "bun:test"
import { escapeHtml, redirectPage } from "../../src/util/redirect.ts"

test("the redirect page is a meta refresh to the escaped link", () => {
  const page = redirectPage("http://x/pair#a&b")
  expect(page).toContain('content="0;url=http://x/pair#a&amp;b"')
  expect(page).toContain('<a href="http://x/pair#a&amp;b">')
  expect(redirectPage('http://x/pair#"><script>')).not.toContain("<script>")
})

test("escapeHtml escapes the five characters html.escape does", () => {
  expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#x27;")
})
