import { expect, test } from "bun:test"
import type { Health } from "@opencorp/protocol"
import { verdict } from "../src/data/version"

const health = (app: Health["app"], api = "0.0.1+aaa"): Health => ({ ok: true, office: { api }, app })

test("no build is the not-built page", () => {
  expect(verdict(health(null), "b1", { dev: false, reloadedFor: null })).toBe("not_built")
})
test("a new build reloads, once per target build", () => {
  const h = health({ build: "b2", api: "0.0.1+aaa" })
  expect(verdict(h, "b1", { dev: false, reloadedFor: null })).toBe("reload")
  expect(verdict(h, "b1", { dev: false, reloadedFor: "b2" })).toBe("ok")
})
test("an app built for another office is out of date, and never reloads", () => {
  expect(verdict(health({ build: "b1", api: "0.0.1+bbb" }), "b1", { dev: false, reloadedFor: null })).toBe("out_of_date")
})
test("under vite dev the build nonce isn't compared", () => {
  expect(verdict(health({ build: "b9", api: "0.0.1+aaa" }), "dev", { dev: true, reloadedFor: null })).toBe("ok")
})
