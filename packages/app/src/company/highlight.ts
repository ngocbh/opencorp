// Syntax colors for Source's file view. highlight.js parses the text into a token tree; the tree becomes lines of
// plain data (strings and class names) that Solid renders as text nodes and spans. highlight.js's HTML output is never
// used, so file text is never parsed as HTML.
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import typescript from "highlight.js/lib/languages/typescript"
import yaml from "highlight.js/lib/languages/yaml"

const LANGUAGES = { yaml, markdown, json, python, bash, typescript, javascript }
for (const [id, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(id, language)

export type Language = { id: keyof typeof LANGUAGES; name: string }

const BY_EXTENSION: Record<string, Language> = {}
for (const [name, id, extensions] of [
  ["YAML", "yaml", "yaml yml"],
  ["Markdown", "markdown", "md markdown"],
  ["JSON", "json", "json"],
  ["Python", "python", "py pyi"],
  ["Shell", "bash", "sh bash zsh"],
  ["TypeScript", "typescript", "ts tsx mts cts"],
  ["JavaScript", "javascript", "js jsx mjs cjs"],
] as const)
  for (const ext of extensions.split(" ")) BY_EXTENSION[ext] = { id, name }

/** Files bigger than this, in bytes, show uncolored so the page stays fast. */
export const MAX_COLORED = 512 * 1024

/**
 * Files with a line longer than this, in characters, show uncolored: highlight.js's YAML grammar takes time quadratic in
 * a long line of unquoted words (a 500 KB line takes about a minute and freezes the tab).
 */
export const MAX_LINE = 5000

/** The language a file's extension names, or undefined for a file shown plain. */
export function languageOf(path: string): Language | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined
}

/** `text`'s size in UTF-8 bytes. */
export const byteLength = (text: string) => new TextEncoder().encode(text).length

/** Why `text` shows uncolored whatever its language, as the file header says it; undefined when it can be colored. */
export function plainReason(text: string, bytes = byteLength(text)): string | undefined {
  if (bytes > MAX_COLORED) return `over ${MAX_COLORED / 1024} KB`
  for (let start = 0; ; ) {
    const end = text.indexOf("\n", start)
    const stop = end === -1 ? text.length : end
    // A CRLF line's \r isn't part of the line.
    if (stop - start - (text[stop - 1] === "\r" ? 1 : 0) > MAX_LINE)
      return `a line over ${MAX_LINE.toLocaleString("en")} characters`
    if (end === -1) return undefined
    start = end + 1
  }
}

/** The language to color `text`, the file at `path`, with; undefined to show it plain. */
export const colorWith = (path: string, text: string, bytes = byteLength(text)) =>
  plainReason(text, bytes) === undefined ? languageOf(path)?.id : undefined

/** A size as the file header shows it. */
export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * A piece of a line: the file's text, a highlight.js span, or a `(hidden)` marker the office put in for a secret. A
 * literal `(hidden)` in a file gets the marker too, since the two can't be told apart. A `(hidden)` that highlight.js
 * cuts across two tokens (a Markdown link's `(hidden)`, or `x((hidden))` in JavaScript) stays plain text.
 */
export type Token = string | { class: string; children: Token[] } | { hidden: true }

/** highlight.js's token tree: text, or a node with an optional scope. */
type Node = string | { scope?: string; children: Node[] }

const MARKER = "(hidden)"

/** highlight.js's CSS class for a scope: `title.function` is `hljs-title function_`; a sub-language is `language-x`. */
function classOf(scope: string) {
  if (scope.startsWith("language:")) return scope.replace("language:", "language-")
  const [first, ...rest] = scope.split(".")
  return [`hljs-${first}`, ...rest.map((piece, i) => `${piece}${"_".repeat(i + 1)}`)].join(" ")
}

/**
 * `text` as lines of tokens, colored with highlight.js `language` when given. The lines' text is `lines(text)`'s: LF
 * or CRLF ends a line, and a final newline doesn't start another. A span that runs over a line end is cut into one span
 * per line, as GitHub does, so each line renders on its own; no span is left empty.
 */
export function tokenLines(text: string, language?: string): Token[][] {
  const code = text.replace(/\r\n/g, "\n")
  if (language) {
    try {
      const result = hljs.highlight(code, { language, ignoreIllegals: true })
      // A grammar error leaves a partial tree: show the text plain instead.
      if (!result.illegal && !result.errorRaised) return toLines((result._emitter as unknown as { root: Node }).root)
    } catch {
      // `_emitter.root` is highlight.js's own field, not its API: a tree that's missing or shaped differently shows
      // the text plain.
    }
  }
  return toLines({ children: [code] })
}

/** A token tree as lines of tokens; throws on a node that isn't text or `{scope?, children}`. */
function toLines(root: Node): Token[][] {
  const out: Token[][] = [[]]
  /** The classes of the spans open at this point, outermost first. */
  const scopes: string[] = []
  /** The current line's open token lists: the line itself, then each open span's children. */
  let open: Token[][] = [out[0]]
  const newLine = () => {
    // Spans that opened right before the line end have nothing on this line.
    for (let i = open.length - 1; i > 0 && open[i].length === 0; i--) open[i - 1].pop()
    const line: Token[] = []
    out.push(line)
    open = [line]
    for (const cls of scopes) {
      const span = { class: cls, children: [] as Token[] }
      open.at(-1)!.push(span)
      open.push(span.children)
    }
  }
  const addText = (s: string) =>
    s.split(MARKER).forEach((piece, i) => {
      if (i > 0) open.at(-1)!.push({ hidden: true })
      if (piece) open.at(-1)!.push(piece)
    })
  const walk = (node: Node) => {
    if (typeof node === "string") return node.split("\n").forEach((piece, i) => (i > 0 && newLine(), addText(piece)))
    if (!node || !Array.isArray(node.children)) throw new Error("not a highlight.js token tree")
    if (!node.scope) return node.children.forEach(walk)
    const cls = classOf(node.scope)
    const span = { class: cls, children: [] as Token[] }
    open.at(-1)!.push(span)
    open.push(span.children)
    scopes.push(cls)
    node.children.forEach(walk)
    scopes.pop()
    const children = open.pop()!
    // A span that ended right after a line end has nothing on its last line.
    if (children.length === 0) open.at(-1)!.pop()
  }
  walk(root)
  if (out.length > 1 && out.at(-1)!.length === 0) out.pop()
  return out
}
