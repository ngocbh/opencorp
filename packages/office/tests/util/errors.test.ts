/** C's strerror texts: util's table and the sandbox helper's own copy say the same. */
import os from "node:os"
import { expect, test } from "bun:test"
import { strerror as helperStrerror } from "../../src/sandbox/fs_helper.ts"
import { strerror } from "../../src/util/errors.ts"

test("util's strerror and the sandbox helper's give the same text for every errno code", () => {
  const codes = Object.keys(os.constants.errno)
  expect(codes.length).toBeGreaterThan(20)
  for (const code of codes) {
    const error = Object.assign(new Error(code), { code })
    expect(strerror(error)).toBe(helperStrerror(error))
  }
  expect(strerror(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("No such file or directory")
})

test("strerror is undefined for what isn't an OS error", () => {
  expect(strerror(new Error("plain"))).toBeUndefined()
  expect(strerror(Object.assign(new Error("x"), { code: "NOT_AN_ERRNO" }))).toBeUndefined()
  expect(strerror("ENOENT")).toBeUndefined()
})
