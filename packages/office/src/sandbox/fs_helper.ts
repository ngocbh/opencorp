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
import util from "node:util"

const MAX_READ_CHARS = 200_000
const MAX_LIST_ENTRIES = 5000
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

/** `text`'s lines, each with its break (Python's `str.splitlines(keepends=True)`). */
function splitLines(text: string): string[] {
  return text.match(LINE) ?? []
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
  const lines = splitLines(fs.readFileSync(path).toString("utf8"))
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

const notBuilt = (): string => {
  throw new OpError("not built yet")
}

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
  search: { args: { pattern: "string", path: "string?", glob: "string?" }, run: notBuilt },
} satisfies Record<string, Op>)

/** The op's arguments from `request`; `null` leaves an optional one out. */
function checkArgs(op: Op, request: Record<string, unknown>): Args {
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
  return args as Args
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
  const op = typeof name === "string" && Object.hasOwn(OPS, name) ? OPS[name]! : undefined
  if (!op) throw new OpError("unknown op")
  const args = checkArgs(op, request as Record<string, unknown>)
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
