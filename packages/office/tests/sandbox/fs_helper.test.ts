/** The `__fs-helper`: one workspace file operation per process, a JSON request in and a JSON reply out. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { helperCommand } from "../../src/platform.ts"
import { run } from "../../src/sandbox/run.ts"
import { tempDir } from "../helpers.ts"
import { helperOp, helperTool, makePolicy, sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(30_000)

/** The parsed reply to `request` in `ws`, its exit status checked against it (0 ok, 1 error). */
function reply(ws: string, request: object): unknown {
  const result = helperOp(ws, request)
  if (result.reply === undefined) throw new Error(`no reply: ${result.stderr}`)
  expect(result.status).toBe((result.reply as { ok: boolean }).ok ? 0 : 1)
  return result.reply
}

const ok = (output: string) => ({ ok: true as const, output })
const error = (text: string) => ({ ok: false as const, error: text })

/** Whether this process runs as root, which reads files whatever their mode. */
const root = process.getuid?.() === 0

/** Writes each `files` entry (path relative to `ws`, then text or bytes), making its folders. */
function tree(ws: string, files: Record<string, string | Buffer>): void {
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true })
    fs.writeFileSync(path.join(ws, name), data)
  }
}

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
  const nul = "a\0b"
  expect(reply(ws, { op: "read_file", path: nul })).toEqual(error("embedded null byte"))
  expect(reply(ws, { op: "write_file", path: nul, content: "" })).toEqual(error("embedded null byte"))
  expect(reply(ws, { op: "edit_file", path: nul, old: "x", new: "y" })).toEqual(error("embedded null byte"))
  expect(reply(ws, { op: "write_file", path: "d\0/x", content: "" })).toEqual(
    error("mkdir: embedded null character in path"),
  )
  expect(reply(ws, { op: "list", path: nul })).toEqual(error("scandir: embedded null character in path"))
  expect(reply(ws, { op: "search", pattern: "x", path: nul })).toEqual(
    error("scandir: embedded null character in path"),
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

test("edit", () => {
  const ws = tempDir()
  const file = path.join(ws, "f.py")
  fs.writeFileSync(file, "a = 1\nb = 1\n")
  const edit = (args: object) => reply(ws, { op: "edit_file", path: "f.py", ...args })
  expect(edit({ old: "= 1", new: "= 2" })).toEqual(
    error("old text appears 2 times in f.py; add context or set replace_all"),
  )
  expect(edit({ old: "a = 1", new: "a = 3" })).toEqual(ok("replaced 1 occurrence in f.py at line 1"))
  expect(edit({ old: "= ", new: "=", replace_all: true })).toEqual(
    ok("replaced 2 occurrences in f.py at lines 1, 2"),
  )
  expect(fs.readFileSync(file, "utf8")).toBe("a =3\nb =1\n")
  expect(edit({ old: "zzz", new: "y" })).toEqual(error("old text not found in f.py"))
  expect(edit({ old: "", new: "y" })).toEqual(error("old must not be empty"))
  // Python's text holds code points, so a lone surrogate is never found, not even in half of a pair.
  fs.writeFileSync(file, "\u{1f600} a\n")
  expect(edit({ old: "\ud83d", new: "x" })).toEqual(error("old text not found in f.py"))
  expect(edit({ old: "a\udc00", new: "x", replace_all: true })).toEqual(error("old text not found in f.py"))
  expect(fs.readFileSync(file, "utf8")).toBe("\u{1f600} a\n")
})

test("edit reports the line each occurrence starts on", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "todo.md"), "# Plan\r\n\r\nStatus: TODO\r\nOwner: minh\r\n")
  expect(reply(ws, { op: "edit_file", path: "todo.md", old: "TODO\r\nOwner", new: "DONE\r\nOwner" })).toEqual(
    ok("replaced 1 occurrence in todo.md at line 3"),
  )
  fs.writeFileSync(path.join(ws, "x.txt"), "x\n\n".repeat(6))
  expect(reply(ws, { op: "edit_file", path: "x.txt", old: "x", new: "y", replace_all: true })).toEqual(
    ok("replaced 6 occurrences in x.txt at lines 1, 3, 5, 7, 9, 11"),
  )
  fs.writeFileSync(path.join(ws, "x.txt"), "x\n".repeat(12))
  expect(reply(ws, { op: "edit_file", path: "x.txt", old: "x", new: "y", replace_all: true })).toEqual(
    ok("replaced 12 occurrences in x.txt at lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …"),
  )
})

test("edit writes dollar signs literally", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), "a b a")
  expect(reply(ws, { op: "edit_file", path: "f", old: "b", new: "$&$$" })).toEqual(
    ok("replaced 1 occurrence in f at line 1"),
  )
  expect(reply(ws, { op: "edit_file", path: "f", old: "a", new: "$'", replace_all: true })).toEqual(
    ok("replaced 2 occurrences in f at lines 1, 1"),
  )
  expect(fs.readFileSync(path.join(ws, "f"), "utf8")).toBe("$' $&$$ $'")
})

test("edit refuses a file that is not utf8 and leaves it unchanged", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), Buffer.from([0xff, 0x41]))
  expect(reply(ws, { op: "edit_file", path: "f", old: "A", new: "B" })).toEqual(
    error("'utf-8' codec can't decode the file"),
  )
  expect(fs.readFileSync(path.join(ws, "f"))).toEqual(Buffer.from([0xff, 0x41]))
})

test("edit keeps a bom", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x62]))
  expect(reply(ws, { op: "edit_file", path: "f", old: "a", new: "c" })).toEqual(
    ok("replaced 1 occurrence in f at line 1"),
  )
  expect(fs.readFileSync(path.join(ws, "f"))).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0x63, 0x62]))
})

/** Runs `body` with a FIFO `fifo` and a link `lnk` to it in `ws`, removing both after. */
function withFifo(ws: string, body: () => void): void {
  const fifo = path.join(ws, "fifo")
  const lnk = path.join(ws, "lnk")
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0)
  fs.symlinkSync("fifo", lnk)
  try {
    body()
  } finally {
    fs.rmSync(lnk, { force: true })
    fs.rmSync(fifo, { force: true })
  }
}

/** Runs `body` with a link `zero` to /dev/zero in `ws`, removing it after. */
function withZero(ws: string, body: () => void): void {
  const zero = path.join(ws, "zero")
  fs.symlinkSync("/dev/zero", zero)
  try {
    body()
  } finally {
    fs.rmSync(zero, { force: true })
  }
}

/** Runs `body` with a sparse file `name` of `size` bytes in `ws` (its first byte `first`), removing it after. */
function withSparse(ws: string, name: string, size: number, first: string, body: () => void): void {
  const file = path.join(ws, name)
  fs.writeFileSync(file, first)
  fs.truncateSync(file, size)
  try {
    body()
  } finally {
    fs.rmSync(file, { force: true })
  }
}

const MARKER = "\n[truncated at 200000 characters; use offset and limit]"

test("read refuses a fifo, directly and through a link", () => {
  const ws = tempDir()
  withFifo(ws, () => {
    expect(reply(ws, { op: "read_file", path: "fifo" })).toEqual(error("not a regular file: fifo"))
    expect(reply(ws, { op: "read_file", path: "lnk" })).toEqual(error("not a regular file: lnk"))
  })
})

test("edit refuses a fifo, directly and through a link", () => {
  const ws = tempDir()
  withFifo(ws, () => {
    expect(reply(ws, { op: "edit_file", path: "fifo", old: "x", new: "y" })).toEqual(error("not a regular file: fifo"))
    expect(reply(ws, { op: "edit_file", path: "lnk", old: "x", new: "y" })).toEqual(error("not a regular file: lnk"))
  })
})

test("write refuses a fifo and a device", () => {
  const ws = tempDir()
  withFifo(ws, () => {
    expect(reply(ws, { op: "write_file", path: "fifo", content: "x" })).toEqual(error("not a regular file: fifo"))
    expect(reply(ws, { op: "write_file", path: "lnk", content: "x" })).toEqual(error("not a regular file: lnk"))
    expect(fs.lstatSync(path.join(ws, "fifo")).isFIFO()).toBe(true)
  })
  expect(reply(ws, { op: "write_file", path: "/dev/null", content: "x" })).toEqual(
    error("not a regular file: /dev/null"),
  )
})

test("read refuses devices, directly and through a link", () => {
  const ws = tempDir()
  withZero(ws, () => {
    expect(reply(ws, { op: "read_file", path: "/dev/zero" })).toEqual(error("not a regular file: /dev/zero"))
    expect(reply(ws, { op: "read_file", path: "zero", limit: 1 })).toEqual(error("not a regular file: zero"))
    expect(reply(ws, { op: "read_file", path: "/dev/urandom" })).toEqual(error("not a regular file: /dev/urandom"))
  })
})

test("edit refuses devices, directly and through a link", () => {
  const ws = tempDir()
  withZero(ws, () => {
    expect(reply(ws, { op: "edit_file", path: "/dev/zero", old: "x", new: "y" })).toEqual(
      error("not a regular file: /dev/zero"),
    )
    expect(reply(ws, { op: "edit_file", path: "zero", old: "x", new: "y" })).toEqual(error("not a regular file: zero"))
  })
})

test("write replaces a longer file", () => {
  const ws = tempDir()
  expect(reply(ws, { op: "write_file", path: "f", content: "long content" })).toEqual(ok("wrote 12 bytes to f"))
  expect(reply(ws, { op: "write_file", path: "f", content: "x" })).toEqual(ok("wrote 1 bytes to f"))
  expect(fs.readFileSync(path.join(ws, "f"), "utf8")).toBe("x")
})

test("edit refuses a file over 64 MiB", () => {
  const ws = tempDir()
  withSparse(ws, "big", 64 * 1024 * 1024 + 1, "x", () => {
    expect(reply(ws, { op: "edit_file", path: "big", old: "x", new: "y" })).toEqual(
      error("file too large to edit: big"),
    )
  })
})

test("edit refuses a result over 64 MiB and leaves the file unchanged", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), "a".repeat(1024))
  // 1024 * 66,000 bytes is 67,584,000, over 67,108,864.
  expect(reply(ws, { op: "edit_file", path: "f", old: "a", new: "b".repeat(66_000), replace_all: true })).toEqual(
    error("edited file would be too large: f"),
  )
  expect(fs.readFileSync(path.join(ws, "f"), "utf8")).toBe("a".repeat(1024))
})

/** read_file's reply as a whole-file read gives it: the bytes decoded (a bad byte as U+FFFD), cut into lines
 *  as Python's `splitlines(keepends=True)` does, lines `offset` to `offset + limit` kept, then capped at
 *  200,000 code points. The reference a read in chunks must equal. */
function wholeRead(data: Buffer, offset: number, limit?: number): string {
  const line = /[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])|[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]+/g
  const lines = data.toString("utf8").match(line) ?? []
  const text = lines.slice(offset, limit === undefined ? undefined : offset + limit).join("")
  const points = [...text]
  return points.length > 200_000 ? points.slice(0, 200_000).join("") + MARKER : text
}

test("read streams across chunk boundaries", () => {
  const ws = tempDir()
  // The helper reads 65,536 bytes at a time; each file puts a break or a character across that boundary.
  const files = [
    Buffer.from(`${"a".repeat(65_535)}\r\nb`),
    Buffer.from(`${"a".repeat(65_535)}é\nx`),
    Buffer.concat([Buffer.alloc(65_535, "a"), Buffer.from([0xff]), Buffer.from("\nb")]),
    Buffer.concat([Buffer.alloc(65_534, "a"), Buffer.from([0xe2, 0x82]), Buffer.from("x\ny")]),
    Buffer.concat([Buffer.alloc(65_535, "a"), Buffer.from("\r"), Buffer.from([0xc3, 0xa9]), Buffer.from("\n")]),
  ]
  for (const [i, data] of files.entries()) {
    fs.writeFileSync(path.join(ws, "f"), data)
    for (const args of [{}, { limit: 1 }, { offset: 1 }, { offset: 1, limit: 1 }, { offset: 2 }]) {
      const want = wholeRead(data, (args as { offset?: number }).offset ?? 0, (args as { limit?: number }).limit)
      expect([i, args, reply(ws, { op: "read_file", path: "f", ...args })]).toEqual([i, args, ok(want)])
    }
  }
})

test("read matches a whole-file read", () => {
  const ws = tempDir()
  const atoms = [
    "a",
    "\r",
    "\n",
    "\r\n",
    "é",
    "\u{1f600}",
    "\u2028",
    "\x85",
    "\v",
    "\x1d",
    "\ufeff",
    [0xff],
    [0xc3],
    [0xe2, 0x82],
    [0xed, 0xa0, 0x80],
    [0xc0, 0x80],
    [0xf0, 0x9f, 0x98],
  ].map((atom) => (typeof atom === "string" ? Buffer.from(atom, "utf8") : Buffer.from(atom)))
  // A fixed linear congruential generator, so the file is the same on every run.
  let seed = 12_345
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31)
  const parts: Buffer[] = []
  for (let size = 0; size < 300_000; ) {
    // Mostly `a`, so lines run long enough to cross chunks.
    const atom = next() % 4 === 0 ? atoms[next() % atoms.length]! : atoms[0]!
    parts.push(atom)
    size += atom.length
  }
  const data = Buffer.concat(parts)
  fs.writeFileSync(path.join(ws, "f"), data)
  const cases: [number, number | undefined][] = [
    [0, undefined],
    [0, 1],
    [1, 2],
    [3, undefined],
    [0, 0],
    [10, 5],
    [10 ** 6, 1],
  ]
  for (const [offset, limit] of cases) {
    const got = reply(ws, { op: "read_file", path: "f", offset, limit })
    expect([offset, limit, got]).toEqual([offset, limit, ok(wholeRead(data, offset, limit))])
  }
})

test("read with limit 1 stops early", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "lines"), "line\n".repeat(1_000_000))
  expect(reply(ws, { op: "read_file", path: "lines", limit: 1 })).toEqual(ok("line\n"))
  expect(reply(ws, { op: "read_file", path: "lines", offset: 999_999, limit: 5 })).toEqual(ok("line\n"))
  // A file with no line break is one line: the code-point cap ends it, and one before `offset` is passed over.
  fs.writeFileSync(path.join(ws, "long"), "x".repeat(3_000_000))
  expect(reply(ws, { op: "read_file", path: "long", limit: 1 })).toEqual(ok(`${"x".repeat(200_000)}${MARKER}`))
  withSparse(ws, "sparse", 64 * 1024 * 1024, "\0", () => {
    expect(reply(ws, { op: "read_file", path: "sparse", offset: 1 })).toEqual(ok(""))
    expect(reply(ws, { op: "read_file", path: "sparse", limit: 0 })).toEqual(ok(""))
  })
})

test("list", () => {
  const ws = tempDir()
  fs.mkdirSync(path.join(ws, "d"))
  fs.writeFileSync(path.join(ws, "f"), "")
  expect(reply(ws, { op: "list", path: "." })).toEqual(ok("d/\nf"))
  expect(reply(ws, { op: "list" })).toEqual(ok("d/\nf"))
  expect(reply(ws, { op: "list", path: "d" })).toEqual(ok("(empty)"))
})

test("list is capped", () => {
  const ws = tempDir()
  const names = Array.from({ length: 5001 }, (_, i) => String(i).padStart(4, "0"))
  for (const name of names) fs.writeFileSync(path.join(ws, name), "")
  expect(reply(ws, { op: "list" })).toEqual(
    ok(`${names.slice(0, 5000).join("\n")}\n[stopped at 5000 of 5001 entries]`),
  )
})

test("list marks folders but not links to them and sorts by code point", () => {
  const ws = tempDir()
  fs.mkdirSync(path.join(ws, "a"))
  for (const name of ["a.txt", "a-b", "\uff01", "\u{1f600}"]) fs.writeFileSync(path.join(ws, name), "")
  fs.symlinkSync("a", path.join(ws, "lnk"))
  expect(reply(ws, { op: "list" })).toEqual(ok("a-b\na.txt\na/\nlnk\n\uff01\n\u{1f600}"))
  fs.writeFileSync(path.join(ws, "f"), "")
  expect(reply(ws, { op: "list", path: "f" })).toEqual(error("Not a directory: f"))
})

test("search", () => {
  const ws = tempDir()
  tree(ws, {
    "src/a.py": "def foo():\n    return 1\n",
    "src/b.txt": "foo bar\n",
    ".git/x": "foo\n",
    bin: Buffer.from("foo\0"),
  })
  expect(reply(ws, { op: "search", pattern: "foo" })).toEqual(ok("src/a.py:1:def foo():\nsrc/b.txt:1:foo bar"))
  expect(reply(ws, { op: "search", pattern: "foo", glob: "*.py" })).toEqual(ok("src/a.py:1:def foo():"))
  expect(reply(ws, { op: "search", pattern: "nothing" })).toEqual(ok("(no matches)"))
  const bad = reply(ws, { op: "search", pattern: "(" }) as { ok: boolean; error: string }
  expect(bad.ok).toBe(false)
  expect(bad.error).toStartWith("bad pattern: ")
})

test("search walks like os walk", () => {
  const ws = tempDir()
  tree(ws, { "t/a.txt": "hit\n", "t/c.txt": "hit\n", "t/b/x.txt": "hit\n", "t/real/r.txt": "hit\n", "t/.git": "hit\n" })
  fs.symlinkSync("real", path.join(ws, "t/lnkdir"))
  fs.symlinkSync("a.txt", path.join(ws, "t/lnkfile"))
  fs.symlinkSync("nowhere", path.join(ws, "t/broken"))
  const all = "t/.git:1:hit\nt/a.txt:1:hit\nt/c.txt:1:hit\nt/lnkfile:1:hit\nt/b/x.txt:1:hit\nt/real/r.txt:1:hit"
  expect(reply(ws, { op: "search", pattern: "hit", path: "t" })).toEqual(ok(all))
  expect(reply(ws, { op: "search", pattern: "hit", path: "t", glob: null })).toEqual(ok(all))
  expect(reply(ws, { op: "search", pattern: "hit", path: "t", glob: "" })).toEqual(ok(all))
  expect(reply(ws, { op: "search", pattern: "hit", path: "missing" })).toEqual(
    error("No such file or directory: missing"),
  )
  fs.symlinkSync("t/real", path.join(ws, "lnk"))
  expect(reply(ws, { op: "search", pattern: "hit", path: "lnk" })).toEqual(ok("lnk/r.txt:1:hit"))
  expect(reply(ws, { op: "search", pattern: "hit", path: "./t/a.txt" })).toEqual(ok("./t/a.txt:1:hit"))
  if (!root) {
    fs.chmodSync(path.join(ws, "t"), 0o000)
    try {
      expect(reply(ws, { op: "search", pattern: "hit", path: "t" })).toEqual(error("Permission denied: t"))
    } finally {
      fs.chmodSync(path.join(ws, "t"), 0o755)
    }
  }
})

test("search reports a bad top path", () => {
  const ws = tempDir()
  withFifo(ws, () => {
    expect(reply(ws, { op: "search", pattern: "hit", path: "fifo" })).toEqual(error("Not a directory: fifo"))
  })
  expect(reply(ws, { op: "search", pattern: "hit", path: "" })).toEqual(
    error("[Errno 2] No such file or directory: ''"),
  )
  if (!root) {
    tree(ws, { "t/locked": "hit\n" })
    fs.chmodSync(path.join(ws, "t/locked"), 0o000)
    expect(reply(ws, { op: "search", pattern: "hit", path: "t/locked" })).toEqual(error("Permission denied: t/locked"))
  }
})

test.skipIf(root)("search passes over an unreadable subfolder and a dangling link below the top", () => {
  const ws = tempDir()
  tree(ws, { "u/a.txt": "hit\n", "u/sub/x.txt": "hit\n" })
  fs.symlinkSync("nowhere", path.join(ws, "u/broken"))
  fs.chmodSync(path.join(ws, "u/sub"), 0o000)
  try {
    expect(reply(ws, { op: "search", pattern: "hit", path: "u" })).toEqual(ok("u/a.txt:1:hit"))
  } finally {
    fs.chmodSync(path.join(ws, "u/sub"), 0o755)
  }
})

test("glob follows fnmatch", () => {
  const ws = tempDir()
  const names = ["a.py", "a.pyc", "b", "x", "z", "]", "^", "-", "[", "a\\b", "ab", "\u{1f600}", "^x]"]
  for (const name of names) fs.writeFileSync(path.join(ws, name), "hit\n")
  const table: [string, string[]][] = [
    ["*.py", ["a.py"]],
    ["[!a]*", ["-", "[", "]", "^", "^x]", "b", "x", "z", "\u{1f600}"]],
    ["[]x]", ["]", "x"]],
    ["[^b]", ["^", "b"]],
    ["[z-a]", []],
    ["[z-ax]", ["x"]],
    ["[^]x]", ["^x]"]],
    ["[!]x]", ["-", "[", "^", "b", "z", "\u{1f600}"]],
    ["[a-0!]", ["-", "[", "]", "^", "b", "x", "z", "\u{1f600}"]],
    ["[a-0!x]", ["-", "[", "]", "^", "b", "z", "\u{1f600}"]],
    ["[", ["["]],
    ["a\\b", ["a\\b"]],
    ["?", ["-", "[", "]", "^", "b", "x", "z", "\u{1f600}"]],
  ]
  for (const [glob, matched] of table) {
    const output = matched.map((name) => `${name}:1:hit`).join("\n") || "(no matches)"
    expect([glob, reply(ws, { op: "search", pattern: "hit", glob })]).toEqual([glob, ok(output)])
  }
  tree(ws, { "src/b/c.py": "hit\n" })
  expect(reply(ws, { op: "search", pattern: "hit", path: "src", glob: "src*py" })).toEqual(ok("src/b/c.py:1:hit"))
  // Interior stars never backtrack (a plain `.*` each would take hours on the longest name a file can have).
  tree(ws, { [`long/${"a".repeat(255)}`]: "hit\n", "long/xaxaxaxaxaxaxb": "hit\n" })
  expect(reply(ws, { op: "search", pattern: "hit", path: "long", glob: "*a*a*a*a*a*a*b" })).toEqual(
    ok("long/xaxaxaxaxaxaxb:1:hit"),
  )
})

test("search skips binary, big and unreadable files", () => {
  const ws = tempDir()
  tree(ws, {
    "s/nul8191": Buffer.concat([Buffer.alloc(8191, "a"), Buffer.from("\0\nhit\n")]),
    "s/nul8192": Buffer.concat([Buffer.alloc(8192, "a"), Buffer.from("\0\nhit\n")]),
    "s/fits": `hit\n${"x".repeat(2_000_000 - 4)}`,
    "s/big": `hit\n${"x".repeat(2_000_001 - 4)}`,
    "s/locked": "hit\n",
  })
  fs.chmodSync(path.join(ws, "s/locked"), 0o000)
  expect(spawnSync("mkfifo", [path.join(ws, "s/fifo")]).status).toBe(0)
  const found = ["s/fits:1:hit", ...(root ? ["s/locked:1:hit"] : []), "s/nul8192:2:hit"]
  expect(reply(ws, { op: "search", pattern: "hit", path: "s" })).toEqual(ok(found.join("\n")))
})

test("search caps matches and lines", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), "hit\n".repeat(200))
  const lines = Array.from({ length: 200 }, (_, i) => `f:${i + 1}:hit`)
  expect(reply(ws, { op: "search", pattern: "hit" })).toEqual(ok(`${lines.join("\n")}\n[stopped at 200 matches]`))
  fs.writeFileSync(path.join(ws, "f"), `hit${"\u{1f600}".repeat(400)}\n`)
  expect(reply(ws, { op: "search", pattern: "hit" })).toEqual(ok(`f:1:hit${"\u{1f600}".repeat(297)}`))
})

test("python regex forms are translated", () => {
  const ws = tempDir()
  fs.writeFileSync(path.join(ws, "f"), "FOO\nfooZ\nxfoo\nfoo bar\noo\n\\Z\n")
  const search = (pattern: string) => reply(ws, { op: "search", pattern })
  expect(search("(?i)foo")).toEqual(ok("f:1:FOO\nf:2:fooZ\nf:3:xfoo\nf:4:foo bar"))
  expect(search("foo\\Z")).toEqual(ok("f:3:xfoo"))
  expect(search("\\Afoo")).toEqual(ok("f:2:fooZ\nf:4:foo bar"))
  expect(search("(?P<w>o)(?P=w)")).toEqual(ok("f:2:fooZ\nf:3:xfoo\nf:4:foo bar\nf:5:oo"))
  expect(search("\\\\Z")).toEqual(ok("f:6:\\Z"))
  expect(search("(?x)a")).toEqual(error("bad pattern: verbose mode is not supported"))
  fs.writeFileSync(path.join(ws, "f"), "a]\nx\n")
  expect(search("[]a]")).toEqual(ok("f:1:a]"))
  expect(search("[^]a]")).toEqual(ok("f:2:x"))
  fs.writeFileSync(path.join(ws, "f"), "\ufeffx\n")
  expect(search("^\ufeffx")).toEqual(ok("f:1:\ufeffx"))
})

test("a planted env file and bunfig preload in the workspace are not read", () => {
  const dir = tempDir()
  const ws = path.join(dir, "ws")
  fs.mkdirSync(ws)
  const marker = path.join(ws, "MARKER")
  const seen = path.join(dir, "seen.json")
  fs.writeFileSync(path.join(ws, ".env"), "PLANTED=1\n")
  fs.writeFileSync(path.join(ws, "bunfig.toml"), 'preload = ["./evil.ts"]\n')
  fs.writeFileSync(
    path.join(ws, "evil.ts"),
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "")\n`,
  )
  const opts = path.join(dir, "opts.ts")
  fs.writeFileSync(
    opts,
    `import { writeFileSync } from "node:fs"\n` +
      `writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env.PLANTED ?? null))\n`,
  )
  const env = { BUN_OPTIONS: `--preload ${opts}` }

  const result = helperOp(ws, { op: "list" }, env)
  expect(result.reply, result.stderr).toEqual({ ok: true, output: ".env\nbunfig.toml\nevil.ts" })
  expect(result.status).toBe(0)
  expect(JSON.parse(fs.readFileSync(seen, "utf8"))).toBeNull()
  expect(fs.existsSync(marker)).toBe(false)

  // The control: without the two flags the same Bun reads both, so the checks above can see them.
  fs.rmSync(seen)
  const [file, ...args] = helperCommand().argv.filter((arg) => arg !== "--no-env-file" && arg !== "--config=/dev/null")
  const raw = spawnSync(file!, args, {
    cwd: ws,
    env: { PATH: "/usr/bin:/bin", HOME: tempDir(), ...env },
    input: JSON.stringify({ op: "list" }),
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(raw.error).toBeUndefined()
  expect(JSON.parse(fs.readFileSync(seen, "utf8"))).toBe("1")
  expect(fs.existsSync(marker)).toBe(true)
})

test.skipIf(!sandboxAvailable())("the helper reads and writes inside the workspace under its own profile", async () => {
  const { root, make } = makePolicy()
  const policy = make()
  fs.writeFileSync(path.join(root, "beside.txt"), "secret")
  expect(await helperTool(policy, { op: "write_file", path: "a.txt", content: "hi" })).toEqual(
    ok("wrote 2 bytes to a.txt"),
  )
  expect(await helperTool(policy, { op: "read_file", path: "a.txt" })).toEqual(ok("hi"))
  expect(await helperTool(policy, { op: "list" })).toEqual(ok("a.txt"))
  expect((await helperTool(policy, { op: "read_file", path: "../beside.txt" })).ok).toBe(false)
  expect((await helperTool(policy, { op: "write_file", path: "../new.txt", content: "x" })).ok).toBe(false)
  expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false)
  // A shorter write truncates the file through its fd, which the profile allows.
  expect(await helperTool(policy, { op: "write_file", path: "a.txt", content: "x" })).toEqual(
    ok("wrote 1 bytes to a.txt"),
  )
  expect(await helperTool(policy, { op: "edit_file", path: "a.txt", old: "x", new: "yz" })).toEqual(
    ok("replaced 1 occurrence in a.txt at line 1"),
  )
  expect(await helperTool(policy, { op: "read_file", path: "a.txt" })).toEqual(ok("yz"))
  // A top path the sandbox denies is an error, not "(no matches)".
  expect((await helperTool(policy, { op: "search", pattern: "secret", path: "../beside.txt" })).ok).toBe(false)
  // Seatbelt denies reading `..`; under bwrap `..` is a tmpfs folder holding only the mount points, so
  // the search succeeds there but sees nothing outside the workspace.
  const above = await helperTool(policy, { op: "search", pattern: "secret", path: ".." })
  if (process.platform === "darwin") expect(above.ok).toBe(false)
  expect(JSON.stringify(above)).not.toContain("secret")
  expect(JSON.stringify(above)).not.toContain("beside")
})

test.skipIf(!sandboxAvailable())("the helper does not run under the shell profile", async () => {
  // The policy has no `helper`, so its profile has none of the helper's rules.
  const result = await run(makePolicy().make(), helperCommand().argv, {
    stdin: JSON.stringify({ op: "list" }),
    timeout: 20,
  })
  expect(result.timedOut).toBe(false)
  expect(result.stdout.toString()).toBe("")
  expect(result.exit).not.toBe(0)
})
