/**
 * Reads the office's import graph from source text, for the repo tests.
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

/**
 * `text` with comments and the contents of strings, templates and regex literals replaced by spaces.
 *
 * Quote, backtick and regex delimiters, `${`/`}` around template code, and every newline stay in place, so offsets
 * and line numbers match the original.
 */
export function blank(text: string): string {
  const out = text.split("")
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
        } else if (c === "`") {
          state = "template"
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
          state = "code"
          regexOk = false
        } else if (c === "$" && next === "{") {
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
  return out.join("")
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
  /** Whether loading the importer never loads the target: `import type`, `export type`, or only `type` names. */
  typeOnly: boolean
  /** Whether it is a file import (`with { type: "file" }`). */
  data: boolean
}

/** Whether a `{ … }`, default or `* as` clause takes only types: `type` before it all, or before each of at least
 *  one name in braces, with no default or `* as` beside them. */
function typeOnlyClause(clause: string): boolean {
  const rest = clause.trim()
  if (/^type\s/.test(rest) && !/^type\s*,/.test(rest) && !/^type\s+from$/.test(rest)) return true
  if (rest.replace(/\{[^}]*\}/, "").split(",").some((part) => part.trim())) return false
  const names = (rest.match(/\{([^}]*)\}/)?.[1] ?? "").split(",").map((part) => part.trim()).filter(Boolean)
  return names.length > 0 && names.every((name) => /^type\s+/.test(name))
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
    // The attribute may span lines and end with a comma.
    const data = /^\s*with\s*\{\s*type\s*:\s*["']file["']\s*,?\s*\}/.test(text.slice(end + 1))
    if (/^import\s*\(/.test(head)) {
      found.push({ kind: "dynamic", specifier, typeOnly: false, data: false })
    } else if (/(?<![\w$])from\s*$/.test(head)) {
      const clause = head.replace(/^(?:import|export)/, "").replace(/(?<![\w$])from\s*$/, "")
      found.push({ kind: "static", specifier, typeOnly: typeOnlyClause(clause), data })
    } else {
      found.push({ kind: "side", specifier, typeOnly: false, data })
    }
  }
  // A triple-slash reference lives in a comment, which `blank` hides. Its path may take either quote.
  for (const match of text.matchAll(/^\/\/\/[ \t]*<reference[ \t]+path[ \t]*=[ \t]*(["'])((?:(?!\1)[^\n])+)\1/gm)) {
    found.push({ kind: "reference", specifier: match[2]!, typeOnly: true, data: false })
  }
  return found
}

/** A JS or TS module's file name: `.ts`, `.tsx`, `.mts`, `.cts`, and their `.js` kin. */
export const CODE = /\.[cm]?[jt]sx?$/

/** Folders `filesUnder` never enters. */
const SKIP = new Set(["node_modules", ".git"])

/** Every file under `root`, as `/`-separated paths relative to it, sorted. It skips `node_modules`, `.git` and a
 *  package's build (a `dist` beside a `package.json`), and doesn't follow links. */
export function filesUnder(root: string): string[] {
  const found: string[] = []
  const walk = (rel: string): void => {
    const dir = path.join(root, rel)
    const pkg = fs.existsSync(path.join(dir, "package.json"))
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !(pkg && entry.name === "dist")) walk(name)
      } else if (entry.isFile()) {
        found.push(name)
      }
    }
  }
  if (fs.existsSync(root)) walk("")
  return found.sort()
}

/** The `src/`-relative path a relative `specifier` in `file` (also `src/`-relative) names. */
export function resolveIn(file: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
}
