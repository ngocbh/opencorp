/**
 * Workspace file operations, run inside the sandbox as one process per call (`__fs-helper`).
 *
 * Reads one JSON request (`{"op": ..., ...args}`) on stdin and writes one JSON reply
 * (`{"ok": true, "output": ...}` or `{"ok": false, "error": ...}`) on stdout, byte for byte as the
 * Python office's helper did. Paths are relative to the working directory, the workspace. The sandbox,
 * not this code, decides what may be read or written. It imports only `node:` builtins, because the
 * sandbox exposes nothing else to it.
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
}

/** `error` as the reply Python's `OSError` branch gave (`<strerror>: <filename>`), or undefined when it
 *  isn't an OS error. `path` names the file when the error doesn't. */
function osError(error: unknown, path: string): OpError | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const errnos: Record<string, number> = os.constants.errno
  if (!(error instanceof Error) || typeof code !== "string" || !Object.hasOwn(errnos, code)) return undefined
  const errno = errnos[code]!
  const libuv = util.getSystemErrorMessage(-errno)
  const text = STRERROR[code] ?? libuv.charAt(0).toUpperCase() + libuv.slice(1)
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

/** Return the file's text, from line `offset` (0-based), at most `limit` lines. */
function readFile(path: string, offset: number, limit: number | undefined): string {
  if (offset < 0 || (limit !== undefined && limit < 0)) throw new OpError("offset and limit must not be negative")
  // A bad byte becomes U+FFFD, as Python's errors="replace"; a BOM is kept.
  const lines = splitLines(fs.readFileSync(path).toString("utf8"), true)
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
    text = STRICT_UTF8.decode(fs.readFileSync(path))
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new OpError("'utf-8' codec can't decode the file")
  }
  const n = count(text, old)
  if (n === 0) throw new OpError(`old text not found in ${path}`)
  if (n > 1 && !replaceAll) throw new OpError(`old text appears ${n} times in ${path}; add context or set replace_all`)
  // Not String.replace with a string, which expands `$&` and `$$` in the replacement.
  const at = text.indexOf(old)
  fs.writeFileSync(
    path,
    replaceAll ? text.split(old).join(replacement) : text.slice(0, at) + replacement + text.slice(at + old.length),
  )
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

/** Orders strings by code point, as Python sorts them (UTF-8 bytes sort in code-point order). */
function byCodePoint(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
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
 *  (`i`, `m`, `s`; `a`, `L`, `u` dropped; `x` refused), `\A` and `\Z` become `^` and `$`, `(?P<n>` becomes
 *  `(?<n>` and `(?P=n)` becomes `\k<n>`; character classes are kept as they are, but for a leading `]`.
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
 *  Ported from CPython's `fnmatch.translate` (Lib/fnmatch.py, PSF-2.0). */
function translateGlob(glob: string): RegExp {
  // Code points, as Python indexes the pattern; the `u` flag matches by code point too.
  const p = [...glob]
  let out = ""
  let i = 0
  while (i < p.length) {
    const c = p[i++]!
    if (c === "*") {
      // A run of `*` is one `.*`.
      if (p[i - 2] !== "*") out += ".*"
    } else if (c === "?") {
      out += "."
    } else if (c === "[") {
      let j = i
      if (p[j] === "!") j++
      if (p[j] === "]") j++
      while (j < p.length && p[j] !== "]") j++
      if (j >= p.length) {
        out += "\\["
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
      if (!body) out += "(?!)"
      else if (body === "!") out += "."
      else out += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`
      i = j + 1
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    }
  }
  return new RegExp(`^${out}$`, "su")
}

/** The files `search` reads, in the order Python's `os.walk(top)` gives them: a file `top` as given, else
 *  top-down, each folder's files sorted, then each sorted subfolder in turn. Folders named `.git` and
 *  symlinked folders below the top aren't entered; a folder that can't be read is passed over. */
function* walk(top: string): Generator<string> {
  let stat: fs.Stats | undefined
  try {
    stat = fs.statSync(top)
  } catch {}
  if (stat?.isFile()) {
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
    else if (!entry.isSymbolicLink() || !isFolder(nodePath.join(root, entry.name))) files.push(entry.name)
  }
  for (const name of files.sort(byCodePoint)) yield nodePath.join(root, name)
  for (const name of folders.sort(byCodePoint)) {
    // os.walk joins without normalizing, so `..` after a link means what the OS makes of it.
    if (name !== ".git") yield* walkFolder(root.endsWith("/") ? root + name : `${root}/${name}`)
  }
}

/** Whether `path` (links followed) is a folder; false when it can't be read. */
function isFolder(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `file`'s bytes, or undefined when `search` skips it: not a regular file (links followed), over
 *  `MAX_SEARCH_FILE_BYTES`, unreadable, or binary (a NUL in its first 8192 bytes). */
function searchable(file: string): Buffer | undefined {
  let data: Buffer
  try {
    // A FIFO or device would block or never end, so only regular files are read.
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) return undefined
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
const ENCODED = new Set(["path", "content", "old", "new"])

// A null prototype, so a request's `op` can't name an inherited property.
const OPS: Record<string, Op> = Object.assign(Object.create(null), {
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
} satisfies Record<string, Op>)

/** The op's arguments from `request`; `null` leaves an optional one out. */
function checkArgs(opName: string, op: Op, request: Record<string, unknown>): Args {
  for (const name of Object.keys(request)) {
    if (name !== "op" && !Object.hasOwn(op.args, name)) throw new OpError(`unexpected argument ${name}`)
  }
  const args: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(op.args)) {
    const optional = spec.endsWith("?")
    const value = Object.hasOwn(request, name) ? request[name] : undefined
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
    // fd 0, not /dev/stdin, which a sandbox profile may not expose.
    reply = `{"ok": true, "output": ${JSON.stringify(serve(fs.readFileSync(0)))}}`
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
