import { expect, test } from "bun:test"
import { defaultSocket, Global, run } from "../src"

test("exports the application lifecycle, its layer, and the default office socket", () => {
  expect(typeof run).toBe("function")
  expect(Global.layer).toBeDefined()
  expect(defaultSocket()).toBe(`${process.env.AC_HOME}/office/office.sock`)
})
