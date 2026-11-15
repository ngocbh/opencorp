/**
 * Reads the office's import graph from source text, for the repo tests and the relayout codemod.
 *
 * `blank` is a small lexer that hides comments and the contents of strings, templates and regex literals, so the
 * import pattern only sees code. It understands TypeScript well enough for that, not fully.
 */
import fs from "node:fs"
import path from "node:path"

/** The office package's folder. */
export const OFFICE = path.resolve(import.meta.dirname, "../..")
/** The office's `src/`. */
export const SRC = path.join(OFFICE, "src")
/** The office's `tests/`. */
export const TESTS = path.join(OFFICE, "tests")

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
])

const IDENTIFIER = /[\p{ID_Continue}$]/u

type State = "code" | "line" | "block" | "string" | "template" | "regex" | "class"

/** A string literal's or template part's text, between its delimiters: `text.slice(start, end)`. */
export interface Literal {
  start: number
  end: number
}

/**
 * `text` with comments and the contents of strings, templates and regex literals replaced by spaces.
 *
 * Quote, backtick and regex delimiters, `${`/`}` around template code, and every newline stay in place, so offsets
 * and line numbers match the original.
 */
export function blank(text: string): string {
  return lex(text).code
}

/** The string literals and template parts of `text`, in order. */
export function literals(text: string): Literal[] {
  return lex(text).literals
}

/** `blank`'s text, and the spans of every string literal and template part. */
function lex(text: string): { code: string; literals: Literal[] } {
  const out = text.split("")
  const found: Literal[] = []
  let opened = 0
  const hide = (i: number): void => {
    if (i < text.length && text[i] !== "\n" && text[i] !== "\r") out[i] = " "
  }
  let state: State = "code"
  let quote = ""
  // One entry per open `${`: the depth of `{` nested inside it, so templates nest.
  const substitutions: number[] = []
  // Whether a `/` here would start a regex literal, judged by the previous token.
  let regexOk = true

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]
    switch (state) {
      case "code":
        if (/\s/.test(c)) break
        if (c === "/" && next === "/") {
          state = "line"
          hide(i)
        } else if (c === "/" && next === "*") {
          state = "block"
          hide(i)
          hide(++i)
        } else if (c === "/") {
          if (regexOk) state = "regex"
          regexOk = true
        } else if (c === '"' || c === "'") {
          state = "string"
          quote = c
          opened = i + 1
        } else if (c === "`") {
          state = "template"
          opened = i + 1
        } else if (IDENTIFIER.test(c)) {
          let j = i
          while (j + 1 < text.length && IDENTIFIER.test(text[j + 1]!)) j++
          // After `.` the word is a property name (`obj.return / 2`), not a keyword.
          regexOk = text[i - 1] !== "." && REGEX_KEYWORDS.has(text.slice(i, j + 1))
          i = j
        } else if (c === ")" || c === "]") {
          regexOk = false
        } else if (c === "!" && !regexOk) {
          // A postfix non-null assertion keeps the operand: `a! / 2` divides.
        } else if ((c === "+" || c === "-") && next === c && !regexOk) {
          i++ // postfix `++`/`--`: `i++ / n` divides
        } else if (c === "}" && substitutions.at(-1) === 0) {
          substitutions.pop()
          state = "template"
          opened = i + 1
        } else {
          if (substitutions.length > 0 && (c === "{" || c === "}")) {
            substitutions.push(substitutions.pop()! + (c === "{" ? 1 : -1))
          }
          regexOk = true
        }
        break
      case "line":
        if (c === "\n") state = "code"
        else hide(i)
        break
      case "block":
        hide(i)
        if (c === "*" && next === "/") {
          hide(++i)
          state = "code"
        }
        break
      case "string":
      case "regex":
      case "class":
        // Neither a quoted string nor a regex literal can span lines.
        if (c === "\n") {
          state = "code"
          regexOk = true
        } else if (c === "\\") {
          hide(i)
          if (next !== "\n") hide(++i)
        } else if (state === "string" && c === quote) {
          found.push({ start: opened, end: i })
          state = "code"
          regexOk = false
        } else if (state === "regex" && c === "/") {
          state = "code"
          regexOk = false
        } else if (state === "regex" && c === "[") {
          state = "class"
          hide(i)
        } else if (state === "class" && c === "]") {
          state = "regex"
          hide(i)
        } else {
          hide(i)
        }
        break
      case "template":
        if (c === "\\") {
          hide(i)
          hide(++i)
        } else if (c === "`") {
          found.push({ start: opened, end: i })
          state = "code"
          regexOk = false
        } else if (c === "$" && next === "{") {
          found.push({ start: opened, end: i })
          substitutions.push(0)
          state = "code"
          regexOk = true
          i++
        } else {
          hide(i)
        }
        break
    }
  }
  return { code: out.join(""), literals: found }
}

// `import`/`export … from "x"`, side-effect `import "x"`, and `import("x")`; the keyword guard keeps a
// semicolon-less `export { a }` from swallowing the next import.
const IMPORT =
  /(?<![\w$.])(?:(?:import|export)(?![\w$])(?:(?!(?<![\w$])(?:import|export)(?![\w$]))[\w$\s{},*])*?(?<![\w$])from\s*|import\s*(?:\(\s*)?)(["'])([^"'\n]*)\1/g

/** How an import is written: `import … from`/`export … from`, `import()`, `import "x"`, or `/// <reference path>`. */
export type ImportKind = "static" | "dynamic" | "side" | "reference"

/** One import or re-export of a file. */
export interface Import {
  kind: ImportKind
  /** The module specifier, as written. */
  specifier: string
  /** The offsets of the specifier's text, inside its quotes. */
  start: number
  end: number
  /** The 1-based line of the specifier. */
  line: number
  /** Whether loading the importer never loads the target: `import type`, `export type`, or only `type` names. */
  typeOnly: boolean
  /** Whether it is a file import (`with { type: "file" }`). */
  data: boolean
  /** The names it takes: `default`, `*`, the imported (not local) names, or `import()` for a dynamic import. */
  names: string[]
}

/** The names a `{ … }`, default or `* as` clause takes, and whether all are types. */
function clauseNames(clause: string): { names: string[]; typeOnly: boolean } {
  let rest = clause.trim()
  const typeAll = /^type\s/.test(rest) && !/^type\s*,/.test(rest) && !/^type\s+from$/.test(rest)
  if (typeAll) rest = rest.replace(/^type\s+/, "")
  const names: string[] = []
  let allTypes = true
  const braces = rest.match(/\{([^}]*)\}/)
  const outside = rest.replace(/\{[^}]*\}/, "").trim()
  for (const part of outside.split(",").map((p) => p.trim()).filter(Boolean)) {
    names.push(part.startsWith("*") ? "*" : "default")
    allTypes = false
  }
  if (braces) {
    for (const part of braces[1]!.split(",").map((p) => p.trim()).filter(Boolean)) {
      const typed = /^type\s+/.test(part)
      if (!typed) allTypes = false
      names.push(part.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
    }
  }
  return { names, typeOnly: typeAll || (names.length > 0 && allTypes) }
}

/** Every import and re-export in `text`. A backtick specifier (`` import(`./x.ts`) ``) isn't recognized. */
export function importsOf(text: string): Import[] {
  const code = blank(text)
  const found: Import[] = []
  for (const match of code.matchAll(IMPORT)) {
    const end = match.index + match[0].length - 1
    const start = end - match[2]!.length
    const specifier = text.slice(start, end)
    const head = code.slice(match.index, start - 1)
    const line = text.slice(0, start).split("\n").length
    const data = /^\s*with\s*\{\s*type\s*:\s*["']file["']\s*\}/.test(text.slice(end + 1))
    if (/^import\s*\(/.test(head)) {
      found.push({ kind: "dynamic", specifier, start, end, line, typeOnly: false, data: false, names: ["import()"] })
    } else if (/(?<![\w$])from\s*$/.test(head)) {
      const clause = head.replace(/^(?:import|export)/, "").replace(/(?<![\w$])from\s*$/, "")
      const { names, typeOnly } = clauseNames(clause)
      found.push({ kind: "static", specifier, start, end, line, typeOnly, data, names })
    } else {
      found.push({ kind: "side", specifier, start, end, line, typeOnly: false, data, names: [] })
    }
  }
  // A triple-slash reference lives in a comment, which `blank` hides.
  for (const match of text.matchAll(/^\/\/\/[ \t]*<reference[ \t]+path[ \t]*=[ \t]*"([^"\n]+)"/gm)) {
    const end = match.index + match[0].length - 1
    const start = end - match[1]!.length
    const line = text.slice(0, start).split("\n").length
    found.push({ kind: "reference", specifier: match[1]!, start, end, line, typeOnly: true, data: false, names: [] })
  }
  return found
}

/** Folders `filesUnder` never enters. */
const SKIP = new Set(["node_modules", "dist", ".git"])

/** Every file under `root`, as `/`-separated paths relative to it, sorted. It skips `node_modules`, `dist` and
 *  `.git`, and doesn't follow links. */
export function filesUnder(root: string): string[] {
  const found: string[] = []
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory() && !SKIP.has(entry.name)) walk(name)
      else if (entry.isFile()) found.push(name)
    }
  }
  if (fs.existsSync(root)) walk("")
  return found.sort()
}

/** The `src/`-relative path a relative `specifier` in `file` (also `src/`-relative) names. */
export function resolveIn(file: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
}
