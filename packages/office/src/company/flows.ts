/** Loads company flows with child flows and CODE references confined to the repo. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type ComposedFlow, loadFlow, LoadError } from "@ngocbh/yian"
import { readFlow, YamlError } from "./flow_yaml.ts"

/**
 * Largest company flow file the office loads, in bytes. It equals HQ's Source view cap (`source.ts`
 * `MAX_FILE`), so every flow that runs can also be viewed; a test pins the two.
 */
export const MAX_FLOW_FILE = 1 << 20

/** `MAX_FLOW_FILE` as messages show it. */
const LIMIT = `${MAX_FLOW_FILE >> 20} MiB`

/** A flow, or one of its `uses:` children, resolves outside the company repo. */
export class FlowOutsideRepo extends Error {
  override name = "FlowOutsideRepo"
}

/**
 * Loads the flow at `file`; it and its `uses:` children load only from inside `root`, and their CODE
 * references resolve only to files inside it.
 *
 * Each file loads at most once per call, however many `uses:` aliases name it. Nothing is kept between
 * calls, so a later call (lint reads the live clone) always reads the files again.
 *
 * @throws {FlowOutsideRepo} For a flow or child outside `root`.
 * @throws {LoadError} For a bad flow, and for a child's other problems below.
 * @throws {RangeError} For a reference cycle, a pinned-version mismatch, a `uses:` ref with a NUL, a flow
 *   that is missing, can't be opened (named by its errno only), isn't a regular file or is over
 *   `MAX_FLOW_FILE` bytes, or a flow that sets `system.paths` or whose YAML the office can't check for it.
 * @throws {TypeError} For a flow that isn't UTF-8 text.
 * @throws {Error} A system error for a read that fails after the open.
 */
export async function loadConfined(root: string, file: string): Promise<ComposedFlow> {
  try {
    return await load(resolvePath(root), file, new Set(), new Map())
  } catch (error) {
    if (!(error instanceof LoadError)) throw error
    // yian wraps what the child resolver throws in its own LoadError.
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      if (cause instanceof FlowOutsideRepo) throw cause
    }
    throw error
  }
}

/**
 * `p` made absolute with symlinks resolved, as Python's non-strict `Path.resolve()`: when `p` doesn't
 * resolve, the real path of its deepest existing ancestor joined with the rest (`..` after a symlinked
 * folder is then applied lexically).
 *
 * A dangling symlink isn't followed: its missing target counts as a missing file, where Python's `resolve()`
 * followed it and could report the target outside the repo.
 */
export function resolvePath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch (error) {
    if (errno(error) === undefined) throw error
  }
  const abs = path.resolve(p)
  for (let candidate = abs; ; ) {
    try {
      return path.join(fs.realpathSync(candidate), path.relative(candidate, abs))
    } catch (error) {
      if (errno(error) === undefined) throw error
      const parent = path.dirname(candidate)
      if (parent === candidate) return abs
      candidate = parent
    }
  }
}

/** Whether `resolved` lies outside `root`; both resolved. A name such as `..x.yaml` inside stays inside. */
export function outsideRoot(root: string, resolved: string): boolean {
  const rel = path.relative(root, resolved)
  return rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)
}

/** A Node system error's errno code, such as `ENOENT`; undefined for anything else thrown. */
export function errno(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
  return typeof code === "string" ? code : undefined
}

/**
 * The errno name of a system error, found by its number so that Node's "Unknown system error -102" gets a
 * name too; undefined for anything else thrown.
 */
function errnoName(error: unknown): string | undefined {
  const number = error instanceof Error ? (error as NodeJS.ErrnoException).errno : undefined
  if (typeof number !== "number") return undefined
  const names = os.constants.errno as Record<string, number>
  return Object.keys(names).find((name) => names[name] === -number) ?? `errno ${-number}`
}

// Opening a socket fails rather than giving fstat a descriptor: ENXIO on Linux, EOPNOTSUPP on macOS.
const NOT_REGULAR = new Set(["ENXIO", "EOPNOTSUPP", "ENOTSUP"])

/**
 * Whether the flow sets `system.paths`, which a custom child resolver would ignore; undefined when the office
 * can't read its YAML.
 */
function declaresSystemPaths(text: string): boolean | undefined {
  let doc: unknown
  try {
    doc = readFlow(text)
  } catch (error) {
    if (error instanceof YamlError) return undefined
    throw error
  }
  const system = isRecord(doc) ? doc["system"] : undefined
  return isRecord(system) && Object.hasOwn(system, "paths")
}

/**
 * The bytes of the flow file at `resolved`, shown in messages as `shown`.
 *
 * @throws {RangeError} When it is missing, can't be opened, isn't a regular file or is over `MAX_FLOW_FILE`
 *   bytes.
 */
function readFlowBytes(resolved: string, shown: string): Buffer {
  const { O_RDONLY, O_NONBLOCK } = fs.constants
  // O_NONBLOCK so a FIFO in its place can't hang the open; fstat then refuses it.
  let fd: number
  try {
    fd = fs.openSync(resolved, O_RDONLY | O_NONBLOCK)
  } catch (error) {
    // The system error's message holds the absolute path, so it isn't kept, not even as the cause.
    const name = errnoName(error)
    if (name === undefined) throw error
    if (name === "ENOENT") throw new RangeError(`${shown} does not exist`)
    if (NOT_REGULAR.has(name)) throw new RangeError(`${shown} is not a regular file`)
    throw new RangeError(`${shown} can't be opened (${name})`)
  }
  try {
    const stats = fs.fstatSync(fd)
    if (!stats.isFile()) throw new RangeError(`${shown} is not a regular file`)
    if (stats.size > MAX_FLOW_FILE) throw new RangeError(`${shown} is over the ${LIMIT} flow size limit`)
    const buf = Buffer.alloc(MAX_FLOW_FILE + 1)
    let size = 0
    while (size < buf.length) {
      const n = fs.readSync(fd, buf, size, buf.length - size, null)
      if (n === 0) break // a short read isn't the end of the file; only 0 is
      size += n
    }
    // The file grew after the stat.
    if (size > MAX_FLOW_FILE) throw new RangeError(`${shown} is over the ${LIMIT} flow size limit`)
    return buf.subarray(0, size)
  } finally {
    fs.closeSync(fd)
  }
}

/** Whether `value` is a plain mapping. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Loads one flow under the resolved `root`; `loading` holds the resolved paths of its ancestors, and `loaded`
 * the flows this top-level load has already finished, by resolved path, so a diamond of `uses:` loads each
 * file once rather than once per path to it.
 *
 * Sharing one loaded flow between aliases is safe: yian copies a child for each alias, and holds a child it
 * gets again to the import-depth limit through the flow's `importDepth`. Were yian to resolve aliases
 * concurrently, the result would stay correct (each branch's `loading` still catches a cycle and each
 * alias's pinned version is still checked); some files would only load twice.
 *
 * yian calls the child resolver as `(ref, version)` for `<dir>/<ref>.yaml`, and wraps anything else it
 * throws in a `LoadError` caused by it. yian ignores `system.paths` when a child resolver is given, so
 * such a flow is refused rather than loaded differently from `yian run`. yian doesn't check a child
 * resolver's flow against `codeRoot`, so each nested load passes it again.
 */
async function load(
  root: string,
  file: string,
  loading: ReadonlySet<string>,
  loaded: Map<string, ComposedFlow>,
): Promise<ComposedFlow> {
  // Resolved paths are compared, so /var -> /private/var on macOS and symlinked roots work.
  const resolved = resolvePath(file)
  const shown = path.relative(root, resolved) // messages show repo-relative paths
  if (outsideRoot(root, resolved)) throw new FlowOutsideRepo(`${shown} is outside the company repo`)
  if (loading.has(resolved)) throw new RangeError(`flow-reference cycle at ${shown}`)
  const cached = loaded.get(resolved)
  if (cached !== undefined) return cached
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readFlowBytes(resolved, shown))
  const declared = declaresSystemPaths(text)
  if (declared === true) {
    throw new RangeError(`${shown}: system.paths is not supported in company flows; use a relative uses: path`)
  }
  const dir = path.dirname(resolved)
  const importing = new Set([...loading, resolved])
  const childResolver = async (ref: string, version: string | null): Promise<ComposedFlow> => {
    if (ref.includes("\0")) throw new RangeError(`${JSON.stringify(ref)}: embedded null byte`)
    const child = await load(root, path.resolve(dir, ref + ".yaml"), importing, loaded)
    if (version !== null && child.version !== version) {
      throw new RangeError(`${ref} is version ${JSON.stringify(child.version)}, not ${JSON.stringify(version)}`)
    }
    return child
  }
  const options = { childResolver, sourceLabel: shown, baseDir: dir, codeRoot: root }
  if (declared === undefined) {
    // The office's reader is stricter than yian's (it refuses merge cycles, which yian accepts), so a read
    // error is never taken as "no system.paths". yian reports a real syntax error with its location.
    await loadFlow(text, options)
    throw new RangeError(`${shown}: system.paths can't be checked in this flow; simplify its YAML`)
  }
  const flow = await loadFlow(text, options)
  loaded.set(resolved, flow)
  return flow
}
