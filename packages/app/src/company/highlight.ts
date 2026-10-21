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

/** The language a file's extension names, or undefined for a file shown plain. */
export function languageOf(path: string): Language | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined
}

/** The language to color a file of `bytes` bytes with, or undefined to show it plain. */
export const colorWith = (path: string, bytes: number) => (bytes <= MAX_COLORED ? languageOf(path)?.id : undefined)

/** `text`'s size in UTF-8 bytes. */
export const byteLength = (text: string) => new TextEncoder().encode(text).length

/** A size as the file header shows it. */
export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A piece of a line: the file's text, a highlight.js span, or a `(hidden)` marker the office put in for a secret. */
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
 * per line, as GitHub does, so each line renders on its own.
 */
export function tokenLines(text: string, language?: string): Token[][] {
  const code = text.replace(/\r\n/g, "\n")
  let root: Node = { children: [code] }
  if (language) {
    const result = hljs.highlight(code, { language, ignoreIllegals: true })
    // A grammar error leaves a partial tree: show the text plain instead.
    if (!result.illegal && !result.errorRaised) root = (result._emitter as unknown as { root: Node }).root
  }
  const out: Token[][] = [[]]
  /** The classes of the spans open at this point, outermost first. */
  const scopes: string[] = []
  /** The current line's open token lists: the line itself, then each open span's children. */
  let open: Token[][] = [out[0]]
  const newLine = () => {
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
