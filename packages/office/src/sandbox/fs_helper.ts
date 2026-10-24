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
  read_file: { args: { path: "string", offset: "integer?", limit: "integer?" }, run: notBuilt },
  write_file: { args: { path: "string", content: "string" }, run: notBuilt },
  edit_file: { args: { path: "string", old: "string", new: "string", replace_all: "boolean?" }, run: notBuilt },
  list: { args: { path: "string?" }, run: notBuilt },
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
