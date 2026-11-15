/** How a command or script that will run is shown to the owner, so what they approve is what runs: characters that
 *  aren't printable ASCII escaped, lines numbered, and padding collapsed. */

/** Anything but printable ASCII and tab, by code point (a lone surrogate on its own). */
const ODD = /[^\x20-\x7e\t]/u

const escape = (c: string) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`

/** How many spaces in a row, inside a line, are shown as a marker rather than drawn: fewer are ordinary spacing
 *  between words, more could push the rest of a line out of view. */
export const SPACE_RUN = 4
/** The deepest indentation shown as is: a script's nesting reads as written, and a run this short can't push a line's
 *  start off the screen. */
export const MAX_INDENT = 16

const spaces = (run: string) => `<${run.length} spaces>`

/** `line` with each character outside printable ASCII and tab shown as `<U+XXXX>`, every tab as `<TAB>`, indentation
 *  of more than `MAX_INDENT` spaces as `<N spaces>`, and each later run of `SPACE_RUN` or more spaces as `<N spaces>`.
 *  A no-break or ideographic space looks like a blank but isn't shell whitespace, so `echo jobs<U+00A0># ; touch x`
 *  would read as a comment and run `touch`; an invisible or bidi character can make text read other than it runs; and
 *  a long run of tabs or spaces, drawn as is, could push the dangerous part of a line past the edge of the screen. A
 *  tab is marked even as indentation, since its width differs between the terminal and the pager. */
export function shownCode(line: string): string {
  const escaped = line.replace(new RegExp(ODD.source, "gu"), escape)
  const indent = /^ */.exec(escaped)![0]
  const rest = escaped
    .slice(indent.length)
    .replace(/\t/g, "<TAB>")
    .replace(new RegExp(` {${SPACE_RUN},}`, "g"), spaces)
  return (indent.length <= MAX_INDENT ? indent : spaces(indent)) + rest
}

/** The first character of `text` other than printable ASCII, tab and newline, as `U+XXXX at line L, column C`, or
 *  null: the model is told where, so it can write it another way. */
export function oddCharacter(text: string): string | null {
  const lines = text.split("\n")
  for (const [i, line] of lines.entries()) {
    const found = ODD.exec(line)
    if (found !== null) {
      const column = [...line.slice(0, found.index)].length + 1
      return `${escape(found[0]).slice(1, -1)} at line ${i + 1}, column ${column}`
    }
  }
  return null
}

/** `text`'s lines, a final newline not making one more. */
function linesOf(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n")
}

/** How many lines `text` has, a final newline not counting as one more. */
export function lineCount(text: string): number {
  return linesOf(text).length
}

/** A shown line that reads as blank: whitespace, or a filler that draws as nothing. */
const BLANK = /^[\s⠀ㅤﾠᅟᅠ]*$/u

/** `text`'s lines numbered and shown with `show` (`shownCode` by default); a run of two or more lines that show as
 *  blank is one "(N blank lines)" marker, the numbering going on after it, so padding can't push a line out of view. */
export function numberedLines(text: string, show: (line: string) => string = shownCode): string[] {
  const lines = linesOf(text).map(show)
  const width = String(lines.length).length
  const out: string[] = []
  for (let i = 0; i < lines.length; ) {
    let end = i
    while (end < lines.length && BLANK.test(lines[end]!)) end++
    if (end - i >= 2) {
      out.push(`  ${" ".repeat(width)}  (${end - i} blank lines)`)
      i = end
      continue
    }
    const number = String(i + 1).padStart(width)
    out.push(lines[i] === "" ? `  ${number}` : `  ${number}  ${lines[i]}`)
    i++
  }
  return out
}
