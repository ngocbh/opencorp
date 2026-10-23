/**
 * Reads company files and flows as YAML 1.2 under the rules TS yian reads flows by: the core schema
 * (`yes`, `on` and dates are text, `0755` is decimal), `<<` merge keys in PyYAML's order, repeated keys
 * refused, and a cap on nesting and on the nodes aliases expand to. Company files and flows are repo
 * content agents write, so reading is linear in the text plus the node cap, never overflows the stack,
 * and refuses bad input only with a `YamlError` whose fixed message names a line, never the text: a
 * company file can hold a password hash.
 */
import { type Alias, isAlias, isMap, isScalar, isSeq, type Node, parseDocument, type Scalar, type YAMLMap } from "yaml"

/** Why a YAML text can't be read: fixed text plus a line number, never the text itself (a company file can hold a password hash). */
export class YamlError extends Error {
  override name = "YamlError"
}

/** Deepest mapping/list nesting read (yian's MAX_YAML_NESTING default). */
export const MAX_NESTING = 200

/** Most nodes a document may expand to, each alias counted as a copy and keys included (yian's MAX_YAML_NODES default). */
export const MAX_NODES = 100_000

const YAML_TAG = "tag:yaml.org,2002:"
const MERGE_TAG = YAML_TAG + "merge"
const CORE_TAGS = new Set(["str", "null", "bool", "int", "float", "map", "seq"].map((name) => YAML_TAG + name))
const TOO_DEEP = "is nested too deeply to read"

/** A company file's YAML as plain data (Python's yaml.safe_load, read as YAML 1.2); a tag outside the core schema is an error. */
export function readYaml(text: string): unknown {
  return read(text, false)
}

/** A flow's YAML as plain data, merge keys expanded and each type-tagged scalar value as its text ("!int 5"); for looking at a flow's shape, not checking it (yian loads and checks flows). */
export function readFlow(text: string): unknown {
  return read(text, true)
}

/** Reads `text` as one YAML document; `flowTags` lets tags outside the core schema through, read as text. */
function read(text: string, flowTags: boolean): unknown {
  // eemeli/yaml breaks lines only at LF and CRLF; yian turns a lone CR into LF first, keeping offsets.
  text = text.replace(/\r(?!\n)/g, "\n")
  // eemeli's own repeated-key check scans every earlier key of a mapping per key (quadratic), so
  // `convert` checks repeats instead. `resolveKnownTags: false` keeps a YAML 1.1 type such as
  // `!!timestamp` or `!!set` a plain node with its tag and a warning, never a Date, bytes or a Set.
  const document = parseDocument(text, {
    version: "1.2",
    schema: "core",
    merge: false,
    resolveKnownTags: false,
    prettyErrors: false,
    uniqueKeys: false,
  })
  // An error's `message` quotes the source line, so only its code and position are used. The
  // library's errors are not in source order.
  const error = first(document.errors)
  if (error !== undefined) {
    throw new YamlError(error.code === "RESOURCE_EXHAUSTION" ? TOO_DEEP : invalid(text, error.pos[0]))
  }
  if (!flowTags) {
    const outside = first(document.warnings.filter((warning) => warning.code === "TAG_RESOLVE_FAILED"))
    if (outside !== undefined) throw new YamlError(invalid(text, outside.pos[0]))
  }
  return new Reader(text, aliasTargets(text, document.contents)).convert(document.contents, 0)
}

/** The problem at the smallest position, if any. */
function first<T extends { pos: [number, number] }>(problems: T[]): T | undefined {
  let found: T | undefined
  for (const problem of problems) if (found === undefined || problem.pos[0] < found.pos[0]) found = problem
  return found
}

/** The 1-based line of offset `pos` in `text`. */
function lineOf(text: string, pos: number): number {
  let line = 1
  for (let i = text.indexOf("\n"); i !== -1 && i < pos; i = text.indexOf("\n", i + 1)) line++
  return line
}

/** The message for a text that isn't valid YAML at offset `pos`. */
function invalid(text: string, pos: number): string {
  return `isn't valid YAML (line ${lineOf(text, pos)})`
}

/**
 * Maps each alias to the latest node anchored with its name before it, as yian's
 * `composeFlowDocument` does: one pre-order walk with an explicit stack, so a deep document can't
 * overflow it. `Alias.resolve` isn't used because it walks the whole document on every call.
 */
function aliasTargets(text: string, root: Node | null): Map<Alias, Node> {
  const anchors = new Map<string, Node>()
  const targets = new Map<Alias, Node>()
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (isAlias(node)) {
      const target = anchors.get(node.source)
      // eemeli reports nothing for an alias with no anchor before it.
      if (target === undefined) throw new YamlError(invalid(text, node.range![0]))
      targets.set(node, target)
      continue
    }
    if (!isScalar(node) && !isMap(node) && !isSeq(node)) continue
    // Registered before the children, so `&a [*a]` names its own list.
    if (node.anchor !== undefined) anchors.set(node.anchor, node)
    // Children pushed in reverse pop in source order, so an anchor is seen before the aliases after it.
    if (isSeq(node)) for (let i = node.items.length - 1; i >= 0; i--) stack.push(node.items[i])
    else if (isMap(node))
      for (let i = node.items.length - 1; i >= 0; i--) stack.push(node.items[i].value, node.items[i].key)
  }
  return targets
}

/** Says whether `key` (alias resolved) is a merge key, as yian's `isMergeKey`: an untagged plain `<<`, or any `!!merge` scalar. */
function isMergeKey(key: unknown): boolean {
  if (!isScalar(key)) return false
  return key.tag === undefined ? key.type === "PLAIN" && key.source === "<<" : key.tag === MERGE_TAG
}

/** Converts a composed document to plain data, following aliases and counting nodes and levels. */
class Reader {
  /** The collections on the current path: an alias to one of them would never end. */
  private readonly active = new Set<Node>()
  private nodes = 0

  constructor(
    private readonly text: string,
    private readonly targets: Map<Alias, Node>,
  ) {}

  /** The node `written` stands for: an alias's target, else itself. */
  private resolve(written: unknown): unknown {
    if (!isAlias(written)) return written
    const target = this.targets.get(written)!
    if (this.active.has(target)) {
      throw new YamlError(`has an alias inside the node it names (line ${lineOf(this.text, written.range![0])})`)
    }
    return target
  }

  /** Counts one more node of the expanded document. */
  private count(): void {
    if (++this.nodes > MAX_NODES) throw new YamlError(`expands to more than ${MAX_NODES} nodes`)
  }

  /** Enters a collection one level below `level`, the level of its parent; returns its level. */
  private enter(node: Node, level: number): number {
    if (level + 1 > MAX_NESTING) throw new YamlError(TOO_DEEP)
    this.active.add(node)
    return level + 1
  }

  /** The value of `written`, a node (or a missing one) whose parent collection is at `level`. */
  convert(written: unknown, level: number): unknown {
    const node = this.resolve(written)
    this.count()
    if (isScalar(node)) return scalarValue(node)
    if (isSeq(node)) {
      const inner = this.enter(node, level)
      const items = node.items.map((item) => this.convert(item, inner))
      this.active.delete(node)
      return items
    }
    if (isMap(node)) {
      const value = this.mapping(node, this.enter(node, level))
      this.active.delete(node)
      return value
    }
    return null // a missing value: `{a}` or `? a`
  }

  /** A mapping at `level` as an object, flattened as PyYAML's `flatten_mapping`: merged sources first, then its own pairs. */
  private mapping(node: YAMLMap, level: number): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    const own: { key: Scalar; value: unknown }[] = []
    const seen = new Set<unknown>()
    for (const pair of node.items) {
      const key = this.resolve(pair.key)
      if (isMergeKey(key)) {
        this.count()
        this.merge(result, pair.value, (pair.key as Node).range![0], level)
        continue
      }
      const at = (pair.key as Node | null)?.range?.[0] ?? node.range![0]
      if (!isScalar(key) || key.value === null) throw new YamlError(invalid(this.text, at))
      // As yian, two written keys repeat when they read as one value; keys written as aliases never do.
      if (!isAlias(pair.key)) {
        if (seen.has(key.value)) throw new YamlError(invalid(this.text, at))
        seen.add(key.value)
      }
      own.push({ key, value: pair.value })
    }
    for (const { key, value } of own) {
      this.count()
      // A type-tagged key reads as its text, as yian reads it: `!str paths` is `paths`.
      const name = key.tag !== undefined && !CORE_TAGS.has(key.tag) ? key.source! : String(key.value)
      assign(result, name, this.convert(value, level))
    }
    return result
  }

  /** Assigns onto `result` the source(s) a merge key's `written` value names, a list's items in reverse. */
  private merge(result: Record<string, unknown>, written: unknown, keyAt: number, level: number): void {
    const refuse = (at: unknown) => {
      const pos = (at as Node | null)?.range?.[0] ?? keyAt
      return new YamlError(`has a merge key whose value isn't a mapping or a list of mappings (line ${lineOf(this.text, pos)})`)
    }
    // A merge value is read by its kind whatever its tag, as yian reads it.
    const value = this.resolve(written)
    let sources: unknown[]
    let inner = level
    if (isMap(value)) sources = [written]
    else if (isSeq(value)) {
      this.count()
      inner = this.enter(value, level)
      for (const item of value.items) if (!isMap(this.resolve(item))) throw refuse(item)
      sources = value.items.toReversed()
    } else throw refuse(written)
    for (const source of sources) {
      const merged = this.convert(source, inner) as Record<string, unknown>
      for (const name of Object.keys(merged)) assign(result, name, merged[name])
    }
    if (isSeq(value)) this.active.delete(value)
  }
}

/** A scalar's value: core-resolved, or its text under a type tag (`!int 5` as "!int 5"). */
function scalarValue(node: Scalar): unknown {
  const tag = node.tag
  // `!` is the non-specific tag, not a type: its scalar is text.
  if (tag === undefined || tag === "!" || CORE_TAGS.has(tag)) return node.value
  if (tag.startsWith(YAML_TAG)) return node.source
  return `${tag} ${node.source}`.trimEnd()
}

/** Sets `obj[key]` as an own property, so `__proto__` is a key, never the prototype. */
function assign(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}
