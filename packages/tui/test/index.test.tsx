import { expect, test } from "bun:test"
import { defaultSocket, Global, run } from "../src"

test("exports the application lifecycle, its layer, and the default office socket", () => {
  expect(typeof run).toBe("function")
  expect(Global.layer).toBeDefined()
  expect(defaultSocket({ OPENCORP_HOME: "/tmp/och" })).toBe("/tmp/och/office/office.sock")
})
