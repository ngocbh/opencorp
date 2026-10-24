/** The `__fs-helper`: one workspace file operation per process, a JSON request in and a JSON reply out. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { tempDir } from "../helpers.ts"
import { helperOp } from "./helpers.ts"

setDefaultTimeout(30_000)

/** The parsed reply to `request` in `ws`, its exit status checked against it (0 ok, 1 error). */
function reply(ws: string, request: object): unknown {
  const result = helperOp(ws, request)
  expect(result.status).toBe((result.reply as { ok: boolean }).ok ? 0 : 1)
  return result.reply
}

const ok = (output: string) => ({ ok: true, output })
const error = (text: string) => ({ ok: false, error: text })

test("requests that are not objects or name no op are error replies", () => {
  const ws = tempDir()
  const cases: [object | string, string][] = [
    ["", "request is not JSON"],
    ["nope", "request is not JSON"],
    ["[]", "request must be a JSON object"],
    ['"x"', "request must be a JSON object"],
    ["null", "request must be a JSON object"],
    [{}, "unknown op"],
    [{ op: 5 }, "unknown op"],
    [{ op: "constructor" }, "unknown op"],
    [{ op: "__proto__" }, "unknown op"],
    [{ op: "toString" }, "unknown op"],
    [{ op: "rm", path: "x" }, "unknown op"],
  ]
  for (const [request, text] of cases) {
    const result = helperOp(ws, request)
    expect(result.stdout).toBe(`{"ok": false, "error": "${text}"}`)
    expect(result.status).toBe(1)
  }
})

test("main round trip", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), "hi")
  const result = helperOp(ws, { op: "read_file", path: "f" })
  expect(result.status).toBe(0)
  expect(result.reply).toEqual({ ok: true, output: "hi" })
})

test("main writes non ascii unescaped", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), "\u00e9")
  expect(helperOp(ws, { op: "read_file", path: "f" }).stdout).toBe('{"ok": true, "output": "\u00e9"}')
})

test("main reports errors", () => {
  const ws = tempDir()
  const missing = helperOp(ws, { op: "read_file", path: "missing" })
  expect(missing.status).toBe(1)
  expect(missing.stdout).toBe('{"ok": false, "error": "No such file or directory: missing"}')
  const unknown = helperOp(ws, { op: "rm", path: "x" })
  expect(unknown.status).toBe(1)
  expect(unknown.reply).toEqual(error("unknown op"))
})

test("write then read", () => {
  const ws = tempDir()
  expect(reply(ws, { op: "write_file", path: "a/b.txt", content: "one\ntwo\nthree\n" })).toEqual(
    ok("wrote 14 bytes to a/b.txt"),
  )
  expect(reply(ws, { op: "read_file", path: "a/b.txt" })).toEqual(ok("one\ntwo\nthree\n"))
  expect(reply(ws, { op: "read_file", path: "a/b.txt", offset: 1, limit: 1 })).toEqual(ok("two\n"))
})

test("read is capped", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "big.txt"), "x".repeat(200_050))
  expect(reply(ws, { op: "read_file", path: "big.txt" })).toEqual(
    ok(`${"x".repeat(200_000)}\n[truncated at 200000 characters; use offset and limit]`),
  )
})

test("read handles offsets, limits and python line breaks", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "x"), "a\r\nb")
  const read = (args: object) => reply(ws, { op: "read_file", path: "x", ...args })
  expect(read({ offset: -1 })).toEqual(error("offset and limit must not be negative"))
  expect(read({ limit: -1 })).toEqual(error("offset and limit must not be negative"))
  expect(read({ offset: 5 })).toEqual(ok(""))
  expect(read({ limit: 0 })).toEqual(ok(""))
  expect(read({ limit: 1 })).toEqual(ok("a\r\n"))
  expect(read({ offset: 1 })).toEqual(ok("b"))
  fs.writeFileSync(path.join(ws, "y"), "a\rb\u2028c\n")
  expect(reply(ws, { op: "read_file", path: "y", offset: 1, limit: 1 })).toEqual(ok("b\u2028"))
})

test("the read cap counts code points", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "big.txt"), `${"x".repeat(199_999)}\u{1f600}\u{1f600}`)
  expect(reply(ws, { op: "read_file", path: "big.txt" })).toEqual(
    ok(`${"x".repeat(199_999)}\u{1f600}\n[truncated at 200000 characters; use offset and limit]`),
  )
})

test("write counts utf8 bytes and makes parents", () => {
  const ws = tempDir()
  expect(reply(ws, { op: "write_file", path: "d/e/f.txt", content: "\u00e9" })).toEqual(
    ok("wrote 2 bytes to d/e/f.txt"),
  )
  expect(fs.readFileSync(path.join(ws, "d/e/f.txt"), "utf8")).toBe("\u00e9")
  expect(reply(ws, { op: "write_file", path: "d", content: "" })).toEqual(error("Is a directory: d"))
  fs.mkdirSync(path.join(ws, "d2"))
  expect(reply(ws, { op: "write_file", path: "d2/", content: "" })).toEqual(error("Is a directory: d2/"))
})

test("bad arguments are error replies", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), "hi")
  expect(reply(ws, { op: "read_file", path: "f", x: 1 })).toEqual(error("unexpected argument x"))
  expect(reply(ws, { op: "read_file" })).toEqual(error("missing argument path"))
  expect(reply(ws, { op: "read_file", path: 5 })).toEqual(error("path must be a string"))
  expect(reply(ws, { op: "read_file", path: "f", offset: "1" })).toEqual(error("offset must be an integer"))
  expect(reply(ws, { op: "read_file", path: "f", limit: null })).toEqual(ok("hi"))
})

test("os errors read as python strerror texts", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), "hi")
  expect(reply(ws, { op: "read_file", path: "." })).toEqual(error("Is a directory: ."))
  expect(reply(ws, { op: "write_file", path: "f/x", content: "" })).toEqual(error("File exists: f"))
  expect(reply(ws, { op: "write_file", path: "f/x/y", content: "" })).toEqual(error("Not a directory: f/x"))
  expect(reply(ws, { op: "write_file", path: "", content: "" })).toEqual(
    error("[Errno 2] No such file or directory: ''"),
  )
})

test("strings that are not well formed are refused", () => {
  const ws = tempDir()
  expect(reply(ws, { op: "write_file", path: "\ud800", content: "" })).toEqual(
    error("'utf-8' codec can't encode character '\\ud800' in position 0: surrogates not allowed"),
  )
  expect(reply(ws, { op: "write_file", path: "x", content: "a\u{1f600}\udc00" })).toEqual(
    error("'utf-8' codec can't encode character '\\udc00' in position 2: surrogates not allowed"),
  )
  expect(reply(ws, { op: "write_file", path: "ab\ud800\ud801c\ud802", content: "" })).toEqual(
    error("'utf-8' codec can't encode characters in position 2-3: surrogates not allowed"),
  )
  expect(fs.readdirSync(ws)).toEqual([])
})

test("a bom is kept by read", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), "\ufeffhi")
  expect(reply(ws, { op: "read_file", path: "f" })).toEqual(ok("\ufeffhi"))
})
