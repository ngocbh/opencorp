/** The app's Playwright fixture server sends the office's own CSP and headers, so the app's CSP check tests what the
 *  office serves. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { CSP, HEADERS } from "../../src/hq/guard.ts"
import { CHECKOUT } from "../../src/hq/version.ts"

const FIXTURE = path.join(CHECKOUT, "packages/app/e2e/fixture.ts")

test("the fixture server uses the offices csp", () => {
  const text = fs.readFileSync(FIXTURE, "utf8")
  expect(text).toMatch(/^import \{ CSP, HEADERS \} from "@opencorp\/office\/hq\/guard"$/mu)
  expect(text).not.toMatch(/\bconst (CSP|HEADERS)\b/u)
  expect(text).not.toContain("default-src")
  expect(HEADERS["content-security-policy"]).toBe(CSP)
})
