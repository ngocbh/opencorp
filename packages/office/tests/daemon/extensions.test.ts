/** The extension list calls register(office) on each extension in order. */
import { expect, test } from "bun:test"
import type { Office } from "../../src/daemon/office.ts"
import { EXTENSIONS, type Extension, ExtensionError, loadExtensions } from "../../src/extensions/index.ts"
import { makeOffice } from "./helpers.ts"

class RuntimeError extends Error {}

/** An extension that records its name in `calls` and the office it got in `seen`. */
const ext = (name: string, calls: string[], seen: Office[] = []): Extension => ({
  name,
  register: (office) => {
    seen.push(office)
    calls.push(name)
  },
})

test("register is called in list order", () => {
  const office = makeOffice()
  const calls: string[] = []
  const seen: Office[] = []
  expect(loadExtensions(office, [ext("b", calls, seen), ext("a", calls, seen)])).toEqual(["b", "a"])
  expect(calls).toEqual(["b", "a"])
  expect(seen).toHaveLength(2)
  for (const got of seen) expect(got).toBe(office)
})

test("a module that raises stops loading and is named", () => {
  const office = makeOffice()
  const calls: string[] = []
  const a: Extension = {
    name: "a",
    register: () => {
      throw new RuntimeError("no db")
    },
  }
  let caught: unknown
  try {
    loadExtensions(office, [a, ext("b", calls)])
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ExtensionError)
  expect((caught as ExtensionError).message).toBe("extension a: no db")
  expect((caught as ExtensionError).cause).toBeInstanceOf(RuntimeError)
  expect(calls).toEqual([])
})

test("the default list is the explicit extensions list", () => {
  const office = makeOffice()
  const calls: string[] = []
  const list = EXTENSIONS as Extension[]
  const namesBefore = list.map((e) => e.name)
  list.push(ext("m", calls))
  try {
    expect(loadExtensions(office)).toEqual([...namesBefore, "m"])
    expect(calls).toEqual(["m"])
  } finally {
    list.pop()
  }
})
