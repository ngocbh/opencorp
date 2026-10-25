/**
 * Workspace file operations, run inside the sandbox as one process per call (`__fs-helper`).
 *
 * Reads one JSON request (`{"op": ..., ...args}`) on stdin and writes one JSON reply
 * (`{"ok": true, "output": ...}` or `{"ok": false, "error": ...}`) on stdout. The reply envelope and the
 * ops' own texts (their outputs, their errors, OS errors) match the Python office's helper byte for byte;
 * the texts for a bad argument, a bad request, a file `edit_file` can't decode and a file too large to
 * read are new, and a bad pattern's text is the JavaScript engine's, not Python's. Paths are relative to
 * the working directory, the workspace. The sandbox, not this code, decides what may be read or written.
 * It imports only `node:` builtins, because the sandbox exposes nothing else to it.
 */
import fs from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import util from "node:util"

const MAX_READ_CHARS = 200_000
const MAX_MATCHES = 200
const MAX_LIST_ENTRIES = 5000
const MAX_LINE_CHARS = 300
const MAX_SEARCH_FILE_BYTES = 2_000_000
const MAX_EDIT_LINES = 10

/** A request that can't be done; the message goes back to the model. */
class OpError extends Error {}

/** C's `strerror` texts (macOS) for the errors file operations meet, as Python reports them. */
const STRERROR: Record<string, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory",
  EEXIST: "File exists",
  ELOOP: "Too many levels of symbolic links",
  ENAMETOOLONG: "File name too long",
  EROFS: "Read-only file system",
  ENOSPC: "No space left on device",
  EIO: "Input/output error",
  EMFILE: "Too many open files",
  ENFILE: "Too many open files in system",
  ETXTBSY: "Text file busy",
  EBUSY: "Resource busy",
  EFBIG: "File too large",
  EINVAL: "Invalid argument",
  EILSEQ: "Illegal byte sequence",
  EDQUOT: "Disc quota exceeded",
  ESTALE: "Stale NFS file handle",
  EOPNOTSUPP: "Operation not supported on socket",
  ENOTSUP: "Operation not supported",
  EDEADLK: "Resource deadlock avoided",
  ENXIO: "Device not configured",
  ENOMEM: "Cannot allocate memory",
}

/** `error`'s errno and its text as Python's `OSError.strerror` gives it (C's `strerror` on macOS), or undefined
 *  when it isn't an OS error. A code the table lacks gets the runtime's text, capitalised as C's is. */
function systemError(error: unknown): { errno: number; text: string } | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const errnos: Record<string, number> = os.constants.errno
  if (!(error instanceof Error) || typeof code !== "string" || !Object.hasOwn(errnos, code)) return undefined
  const errno = errnos[code]!
  const libuv = util.getSystemErrorMessage(-errno)
  return { errno, text: STRERROR[code] ?? libuv.charAt(0).toUpperCase() + libuv.slice(1) }
}

/** `error`'s text as Python's `OSError.strerror` gives it, or undefined when it isn't an OS error. */
export function strerror(error: unknown): string | undefined {
  return systemError(error)?.text
}

/** `error` as the reply Python's `OSError` branch gave (`<strerror>: <filename>`), or undefined when it
 *  isn't an OS error. `path` names the file when the error doesn't. */
function osError(error: unknown, path: string): OpError | undefined {
  const known = systemError(error)
  if (!known) return undefined
  const { errno, text } = known
  // The runtime's errors for "" and for reading a folder carry no path.
  const filename = (error as NodeJS.ErrnoException).path ?? path
  return new OpError(filename ? `${text}: ${filename}` : `[Errno ${errno}] ${text}: ''`)
}

/** Python's error for encoding `text` (not well formed) as UTF-8: the first run of lone surrogates,
 *  by code-point position. */
function encodeError(text: string): OpError {
  const points = [...text]
  const lone = (point: string | undefined) => point !== undefined && /^[\ud800-\udfff]$/.test(point)
  const start = points.findIndex(lone)
  let end = start
  while (lone(points[end + 1])) end++
  const what =
    start === end
      ? `character '\\u${points[start]!.charCodeAt(0).toString(16)}' in position ${start}`
      : `characters in position ${start}-${end}`
  return new OpError(`'utf-8' codec can't encode ${what}: surrogates not allowed`)
}

/** A line and its break, as Python's `str.splitlines(keepends=True)` cuts them: at `\r\n` or any of
 *  `\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029`, a last line without a break kept. */
const LINE = /[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])|[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]+/g

/** `text`'s lines, each with its break when `keepEnds` (Python's `str.splitlines`). */
function splitLines(text: string, keepEnds = false): string[] {
  if (keepEnds) return text.match(LINE) ?? []
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  // A text that ends at a break (or is empty) leaves an empty last piece that Python doesn't return.
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/** The first `cap` code points of `text` (Python counts code points), or undefined when it has no more. */
function cut(text: string, cap: number): string | undefined {
  if (text.length <= cap) return undefined
  let end = 0
  for (let n = 0; n < cap && end < text.length; n++) end += text.codePointAt(end)! > 0xffff ? 2 : 1
  return end < text.length ? text.slice(0, end) : undefined
}

/** Python's `os.path.dirname`: the text before the last `/`, its trailing slashes stripped unless it is
 *  all slashes. */
function dirname(path: string): string {
  const head = path.slice(0, path.lastIndexOf("/") + 1)
  return /^\/*$/.test(head) ? head : head.replace(/\/+$/, "")
}

/** `decode` applied to the file's bytes. A file too large for a Buffer or a string is an `OpError`.
 *
 *  The runtime throws a RangeError (or ERR_STRING_TOO_LONG) without an errno for that, which would
 *  otherwise end the helper with no reply. Untested: it needs a file of gigabytes. */
function readText(path: string, decode: (data: Buffer) => string): string {
  try {
    return decode(fs.readFileSync(path))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    const errno = typeof code === "string" && Object.hasOwn(os.constants.errno, code)
    if (!errno && (error instanceof RangeError || code === "ERR_STRING_TOO_LONG")) {
      throw new OpError(`file too large to read: ${path}`)
    }
    throw error
  }
}

/** Return the file's text, from line `offset` (0-based), at most `limit` lines. */
function readFile(path: string, offset: number, limit: number | undefined): string {
  if (offset < 0 || (limit !== undefined && limit < 0)) throw new OpError("offset and limit must not be negative")
  // A bad byte becomes U+FFFD, as Python's errors="replace"; a BOM is kept.
  const lines = splitLines(readText(path, (data) => data.toString("utf8")), true)
  const text = lines.slice(offset, limit === undefined ? undefined : offset + limit).join("")
  const head = cut(text, MAX_READ_CHARS)
  return head === undefined ? text : `${head}\n[truncated at ${MAX_READ_CHARS} characters; use offset and limit]`
}

/** Create or replace the file with `content`, creating parent directories. */
function writeFile(path: string, content: string): string {
  const parent = dirname(path)
  if (parent) fs.mkdirSync(parent, { recursive: true })
  const data = Buffer.from(content, "utf8")
  fs.writeFileSync(path, data)
  return `wrote ${data.length} bytes to ${path}`
}

/** How many times `part` occurs in `text`, without overlaps (Python's `str.count`). */
function count(text: string, part: string): number {
  let n = 0
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) n++
  return n
}

// Strict, as Python's `open(encoding="utf-8")`; a BOM stays in the text, as it does there.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** Replace `old` with `replacement`; `old` must occur exactly once unless `replaceAll`.
 *
 *  The reply names the line (1-based) each replaced occurrence starts on, the first `MAX_EDIT_LINES` of them. */
function editFile(path: string, old: string, replacement: string, replaceAll: boolean): string {
  if (!old) throw new OpError("old must not be empty")
  let text: string
  try {
    text = readText(path, (data) => STRICT_UTF8.decode(data))
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new OpError("'utf-8' codec can't decode the file")
  }
  // A lone surrogate in `old` never occurs in Python's text of code points, though JavaScript would find
  // it in half of a surrogate pair.
  const n = old.isWellFormed() ? count(text, old) : 0
  if (n === 0) throw new OpError(`old text not found in ${path}`)
  if (n > 1 && !replaceAll) throw new OpError(`old text appears ${n} times in ${path}; add context or set replace_all`)
  // Not String.replace with a string, which expands `$&` and `$$` in the replacement.
  if (replaceAll) {
    fs.writeFileSync(path, text.split(old).join(replacement))
  } else {
    const at = text.indexOf(old)
    fs.writeFileSync(path, text.slice(0, at) + replacement + text.slice(at + old.length))
  }
  const replaced = replaceAll ? n : 1
  const lines = starts(text, old, Math.min(replaced, MAX_EDIT_LINES))
  const where =
    replaced === 1 ? `line ${lines[0]}` : `lines ${lines.join(", ")}${replaced > lines.length ? ", …" : ""}`
  return `replaced ${replaced} occurrence${replaced > 1 ? "s" : ""} in ${path} at ${where}`
}

/** The 1-based lines the first `limit` non-overlapping occurrences of `old` start on; lines end at `\n`. */
function starts(text: string, old: string, limit: number): number[] {
  const lines: number[] = []
  let line = 1
  let pos = 0
  while (lines.length < limit) {
    const found = text.indexOf(old, pos)
    line += count(text.slice(pos, found), "\n")
    lines.push(line)
    line += count(old, "\n")
    pos = found + old.length
  }
  return lines
}

/** Orders well-formed strings by code point, as Python sorts them. */
function byCodePoint(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x === y) continue
    // UTF-16 code units sort U+E000-U+FFFF after the surrogates that encode U+10000 and up, where code
    // points sort them before; moving the surrogates above U+FFFF restores code-point order.
    if (x < 0xd800 || y < 0xd800) return x - y
    return (x < 0xe000 ? x + 0x2000 : x - 0x800) - (y < 0xe000 ? y + 0x2000 : y - 0x800)
  }
  return a.length - b.length
}

/** Return the directory's entries, sorted, with a `/` after each subdirectory.
 *
 *  Stops after 5000 entries, so the reply stays bounded. */
function listDir(path: string): string {
  // A Dirent's type is the entry's own: a link to a folder gets no `/`.
  const names = fs
    .readdirSync(path, { withFileTypes: true })
    .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
    .sort(byCodePoint)
  if (names.length > MAX_LIST_ENTRIES) {
    return `${names.slice(0, MAX_LIST_ENTRIES).join("\n")}\n[stopped at ${MAX_LIST_ENTRIES} of ${names.length} entries]`
  }
  return names.join("\n") || "(empty)"
}

/** `pattern`, a Python regex, compiled as a JavaScript one. A leading inline-flag group becomes flags
 *  (`i`, `m`, `s`; `a`, `L`, `u` dropped, `a` being JavaScript's default anyway; `x` refused), `\A` and `\Z`
 *  become `^` and `$`, `(?P<n>` becomes `(?<n>` and `(?P=n)` becomes `\k<n>`; character classes are kept as
 *  they are, but for a leading `]`. What still differs: without the `u` flag, `\w`, `\d`, `\s` and `\b` are
 *  ASCII-only where Python's are Unicode, `.` and classes match UTF-16 code units (`^.$` misses an emoji,
 *  `[😀]` matches any character sharing its high surrogate), and `\U0001f600` and `\N{...}` match their
 *  letters literally; `x{,3}` is literal text (Python's `x{0,3}`); `(?P=n)` with no group `n` matches the
 *  literal text `k<n>` where Python refuses the pattern; and the engine's backtracking limit makes a
 *  pattern that runs too long report no match, silently, where Python ran on to the file timeout.
 *  Throws an `OpError` for a pattern that doesn't compile. */
function translateRegex(pattern: string): RegExp {
  const lead = /^\(\?([aiLmsux]+)\)/.exec(pattern)
  const given = lead?.[1] ?? ""
  if (given.includes("x")) throw new OpError("bad pattern: verbose mode is not supported")
  const flags = [..."ims"].filter((flag) => given.includes(flag)).join("")
  let source = ""
  let i = lead ? lead[0].length : 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === "\\") {
      // Escapes are read in pairs, left to right, so `\\Z` stays a backslash and a `Z`.
      const next = pattern[i + 1] ?? ""
      // A searched line holds no line break, so `^` and `$` are its ends, `m` flag or not.
      source += next === "A" ? "^" : next === "Z" ? "$" : c + next
      i += 2
    } else if (c === "[") {
      // As Python reads a class: a `]` first (or after `^`) is a member, and an escape is skipped.
      let j = i + 1
      if (pattern[j] === "^") j++
      source += pattern.slice(i, j)
      if (pattern[j] === "]") {
        // Escaped, or JavaScript reads `[]a]` as an empty class and `[^]a]` as any character.
        source += "\\]"
        j++
      }
      const from = j
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1
      source += pattern.slice(from, j + 1)
      i = j + 1
    } else if (pattern.startsWith("(?P<", i)) {
      source += "(?<"
      i += 4
    } else if (pattern.startsWith("(?P=", i) && pattern.includes(")", i)) {
      const close = pattern.indexOf(")", i)
      source += `\\k<${pattern.slice(i + 4, close)}>`
      i = close + 1
    } else {
      source += c
      i++
    }
  }
  try {
    // No `u` flag: with it, forms Python accepts (`a\-b`, `a{`) don't compile.
    return new RegExp(source, flags)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new OpError(`bad pattern: ${error.message}`)
  }
}

/** The shell pattern `glob` as an anchored RegExp that matches as Python 3.12's `fnmatch.fnmatch` does on
 *  POSIX: `*` any run, `?` any one character, `[...]` a class (`!` first negates), all else literal.
 *  Ported from CPython 3.12's `fnmatch.translate` (Lib/fnmatch.py, PSF-2.0). */
function translateGlob(glob: string): RegExp {
  // Code points, as Python indexes the pattern; the `u` flag matches by code point too.
  const p = [...glob]
  // Each piece's regex source; `null` stands for a run of `*`.
  const parts: (string | null)[] = []
  let i = 0
  while (i < p.length) {
    const c = p[i++]!
    if (c === "*") {
      if (parts.at(-1) !== null) parts.push(null)
    } else if (c === "?") {
      parts.push(".")
    } else if (c === "[") {
      let j = i
      if (p[j] === "!") j++
      if (p[j] === "]") j++
      while (j < p.length && p[j] !== "]") j++
      if (j >= p.length) {
        parts.push("\\[")
        continue
      }
      // The class (its `!` too) split at each `-` that makes a range; a `-` first or last is a member.
      const chunks: string[][] = []
      let from = i
      for (let k = p.indexOf("-", p[i] === "!" ? i + 2 : i + 1); k >= 0 && k < j; k = p.indexOf("-", k + 3)) {
        chunks.push(p.slice(from, k))
        from = k + 1
      }
      const last = p.slice(from, j)
      if (last.length > 0) chunks.push(last)
      else chunks.at(-1)!.push("-")
      // A reversed range is dropped, as Python does (the regex would be invalid).
      for (let k = chunks.length - 1; k > 0; k--) {
        if (chunks[k - 1]!.at(-1)!.codePointAt(0)! > chunks[k]![0]!.codePointAt(0)!) {
          chunks[k - 1] = [...chunks[k - 1]!.slice(0, -1), ...chunks[k]!.slice(1)]
          chunks.splice(k, 1)
        }
      }
      // Escaped so that Python's `[]x]` and `[^]x]` don't read as JavaScript's empty or any-character class.
      const body = chunks.map((chunk) => chunk.join("").replace(/[\\\]\[^-]/g, "\\$&")).join("-")
      // A `!` that leads once reversed ranges are gone negates, as in Python: `[a-0!]` is any character.
      if (!body) parts.push("(?!)")
      else if (body === "!") parts.push(".")
      else parts.push(body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`)
      i = j + 1
    } else {
      parts.push(c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    }
  }
  // As in Python, every `*` but the last matches the shortest run followed by `fixed` (the pieces up to the
  // next `*`) and is never retried longer, so stars can't backtrack exponentially. Python spells that
  // `(?>.*?fixed)`; JavaScript has no atomic groups, but a lookahead is never backtracked into, so the run
  // it captures is matched again by a backreference (named, so a digit in `fixed` can't extend its number).
  let out = ""
  i = 0
  while (i < parts.length && parts[i] !== null) out += parts[i++]
  let groups = 0
  while (i < parts.length) {
    i++
    let fixed = ""
    while (i < parts.length && parts[i] !== null) fixed += parts[i++]
    if (i === parts.length) out += `.*${fixed}`
    else out += `(?=(?<g${++groups}>.*?${fixed}))\\k<g${groups}>`
  }
  return new RegExp(`^${out}$`, "su")
}

/** The files `search` reads, in the order Python's `os.walk(top)` gives them: a file `top` as given, else
 *  top-down, each folder's files sorted, then each sorted subfolder in turn. Folders named `.git` and
 *  symlinked folders below the top aren't entered; a folder that can't be read is passed over. */
function* walk(top: string): Generator<string> {
  if (stat(top)?.isFile()) {
    yield top
    return
  }
  yield* walkFolder(top)
}

/** The files under `root`, `os.walk` order, as `normpath(join(root, name))`. */
function* walkFolder(root: string): Generator<string> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const files: string[] = []
  const folders: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) folders.push(entry.name)
    else if (!entry.isSymbolicLink() || !stat(nodePath.join(root, entry.name))?.isDirectory()) files.push(entry.name)
  }
  for (const name of files.sort(byCodePoint)) yield nodePath.join(root, name)
  for (const name of folders.sort(byCodePoint)) {
    // os.walk joins without normalizing, so `..` after a link means what the OS makes of it.
    if (name !== ".git") yield* walkFolder(root.endsWith("/") ? root + name : `${root}/${name}`)
  }
}

/** `path`'s stat, links followed, or undefined when it can't be read. */
function stat(path: string): fs.Stats | undefined {
  try {
    return fs.statSync(path)
  } catch {
    return undefined
  }
}

/** `file`'s bytes, or undefined when `search` skips it: not a regular file (links followed), over
 *  `MAX_SEARCH_FILE_BYTES`, unreadable, or binary (a NUL in its first 8192 bytes). */
function searchable(file: string): Buffer | undefined {
  const info = stat(file)
  // A FIFO or device would block or never end, so only regular files are read.
  if (!info?.isFile() || info.size > MAX_SEARCH_FILE_BYTES) return undefined
  let data: Buffer
  try {
    data = fs.readFileSync(file)
  } catch {
    return undefined
  }
  return data.subarray(0, 8192).includes(0) ? undefined : data
}

/** Return `file:line:text` for each line matching the regex `pattern`.
 *
 *  Skips `.git`, binary files, and files over 2 MB; `glob` filters on the file name or its path. */
function search(pattern: string, top: string, glob: string | undefined): string {
  const rx = translateRegex(pattern)
  const only = glob ? translateGlob(glob) : undefined
  const matches: string[] = []
  for (const file of walk(top)) {
    if (only && !(only.test(file.slice(file.lastIndexOf("/") + 1)) || only.test(file))) continue
    const data = searchable(file)
    if (!data) continue
    let number = 0
    for (const line of splitLines(data.toString("utf8"))) {
      number++
      if (!rx.test(line)) continue
      matches.push(`${file}:${number}:${cut(line, MAX_LINE_CHARS) ?? line}`)
      if (matches.length >= MAX_MATCHES) return `${matches.join("\n")}\n[stopped at ${MAX_MATCHES} matches]`
    }
  }
  return matches.join("\n") || "(no matches)"
}

type Kind = "string" | "integer" | "boolean"

/** Every op's arguments, each checked against the op's spec before `run` sees it. */
interface Args {
  path?: string
  offset?: number
  limit?: number
  content?: string
  old?: string
  new?: string
  replace_all?: boolean
  pattern?: string
  glob?: string
}

/** An op: its arguments by JSON name (`?` marks an optional one) and what it does with them. */
interface Op {
  args: Record<string, Kind | `${Kind}?`>
  run(args: Args): string
}

/** String arguments that become bytes (a file name or file text), so must be well formed. */
const ENCODED = new Set(["path", "content", "new"])

const OPS: Record<string, Op> = {
  read_file: {
    args: { path: "string", offset: "integer?", limit: "integer?" },
    run: (a: Args) => readFile(a.path!, a.offset ?? 0, a.limit),
  },
  write_file: { args: { path: "string", content: "string" }, run: (a: Args) => writeFile(a.path!, a.content!) },
  edit_file: {
    args: { path: "string", old: "string", new: "string", replace_all: "boolean?" },
    run: (a: Args) => editFile(a.path!, a.old!, a.new!, a.replace_all ?? false),
  },
  list: { args: { path: "string?" }, run: (a: Args) => listDir(a.path ?? ".") },
  search: {
    args: { pattern: "string", path: "string?", glob: "string?" },
    run: (a: Args) => search(a.pattern!, a.path ?? ".", a.glob),
  },
}

/** The op's arguments from `request`; `null` leaves an optional one out. A NUL in `path` is refused here,
 *  before the op's own checks (Python checked offset, limit, `old` and the pattern first). */
function checkArgs(opName: string, op: Op, request: Record<string, unknown>): Args {
  for (const name of Object.keys(request)) {
    if (name !== "op" && !Object.hasOwn(op.args, name)) throw new OpError(`unexpected argument ${name}`)
  }
  const args: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(op.args)) {
    const optional = spec.endsWith("?")
    const value = request[name]
    if (value === undefined || (value === null && optional)) {
      if (!optional) throw new OpError(`missing argument ${name}`)
      continue
    }
    const kind = optional ? spec.slice(0, -1) : spec
    if (kind === "integer" ? !Number.isInteger(value) : typeof value !== kind) {
      throw new OpError(`${name} must be ${kind === "integer" ? "an" : "a"} ${kind}`)
    }
    if (typeof value === "string" && ENCODED.has(name) && !value.isWellFormed()) throw encodeError(value)
    args[name] = value
  }
  const path = args.path
  if (typeof path === "string" && path.includes("\0")) throw nulError(opName, path)
  return args as Args
}

/** Python's error for the NUL in `path`: `os.scandir` (list, search) and `os.mkdir` (write_file's
 *  parent folders) word it apart from `open`. The runtime would throw a TypeError instead. */
function nulError(op: string, path: string): OpError {
  if (op === "list" || op === "search") return new OpError("scandir: embedded null character in path")
  if (op === "write_file" && path.slice(0, path.lastIndexOf("/") + 1).includes("\0")) {
    return new OpError("mkdir: embedded null character in path")
  }
  return new OpError("embedded null byte")
}

/** The output of the request in `input`; throws an `OpError` for a reply that is an error. */
function serve(input: Buffer): string {
  let request: unknown
  try {
    request = JSON.parse(input.toString("utf8"))
  } catch {
    throw new OpError("request is not JSON")
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new OpError("request must be a JSON object")
  }
  const name = (request as Record<string, unknown>).op
  if (typeof name !== "string" || !Object.hasOwn(OPS, name)) throw new OpError("unknown op")
  const op = OPS[name]!
  const args = checkArgs(name, op, request as Record<string, unknown>)
  try {
    return op.run(args)
  } catch (error) {
    // Only list and search leave the path out, and both default it to ".".
    throw osError(error, args.path ?? ".") ?? error
  }
}

/** Serves one request from stdin and writes its reply to stdout; resolves to 0 on success, 1 on a
 *  reported error. Any other exception propagates, with no reply. */
export async function fsHelperMain(): Promise<number> {
  let reply: string
  let ok: boolean
  try {
    // process.stdin is fd 0, not /dev/stdin, which a sandbox profile may not expose; read as a stream,
    // since a synchronous read of a non-blocking stdin fails with EAGAIN.
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    reply = `{"ok": true, "output": ${JSON.stringify(serve(Buffer.concat(chunks)))}}`
    ok = true
  } catch (error) {
    if (!(error instanceof OpError)) throw error
    // JSON.stringify escapes what Python's json.dump(..., ensure_ascii=False) escapes here.
    reply = `{"ok": false, "error": ${JSON.stringify(error.message)}}`
    ok = false
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(reply, (error) => (error ? reject(error) : resolve()))
  })
  return ok ? 0 : 1
}

if (import.meta.main) process.exitCode = await fsHelperMain()
