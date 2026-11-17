/** What the model reads of a shell, and what its record keeps: the screen's text, as it is.
 *
 *  Escape sequences go (CSI, OSC with the shell's markers, DCS and the other strings, single-character escapes),
 *  CR-LF becomes LF, a line redrawn after a lone CR keeps its last text, and backspaces apply. Nothing else is cut:
 *  OpenCorp scrubs nothing here. What the owner types and the terminal echoes is on the screen, so it is in the view;
 *  input the program doesn't echo, as at a password prompt, never reaches the output, so it is in none.
 *
 *  The escape parser follows the DEC VT parser's states (vt100.net/emu/dec_ansi_parser), as terminal emulators do,
 *  and keeps only its state between chunks. A full-screen program reads as its text in the order drawn; a headless
 *  emulator's rendered rows would be its screen exactly. */

/** A C0 or C1 control, or DEL: where plain text stops in the ground state. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

/** What the parser is inside: plain text, an escape, its intermediates, a CSI, an OSC, or a DCS, SOS, PM or APC
 *  string, which ends at ST. */
type State = "ground" | "escape" | "intermediate" | "csi" | "osc" | "string"

/** Text a model may read from a terminal's bytes; keeps an unfinished escape for the next chunk.
 *
 *  Its text holds `\n` for each line end, `\r` for a lone CR and `\b` for a backspace, for the reader to apply.
 *  An OSC or other string that is never closed hides the output after it until ESC, ST, CAN or SUB (or BEL, for
 *  an OSC), as xterm does: the screen shows none of it either. */
export class PlainText {
  private state: State = "ground"
  /** A CR whose next character tells a line end (LF) from a redraw. */
  private cr = false

  /** The text in `chunk`, decoded from the terminal's bytes. */
  push(chunk: string): string {
    let out = ""
    let at = 0
    while (at < chunk.length) {
      if (this.state === "ground") {
        CONTROL.lastIndex = at
        const found = CONTROL.exec(chunk)
        const end = found ? found.index : chunk.length
        if (end > at) out += this.text(chunk.slice(at, end))
        if (!found) break
        out += this.control(chunk.charCodeAt(end))
        at = end + 1
        continue
      }
      out += this.inside(chunk.charCodeAt(at))
      at += 1
    }
    return out
  }

  /** What is held at the end of the output: a lone CR. An unfinished escape is dropped, never text. */
  flush(): string {
    const out = this.cr ? "\r" : ""
    this.cr = false
    this.state = "ground"
    return out
  }

  /** Printable text, after the CR held before it. */
  private text(text: string): string {
    const out = this.cr ? `\r${text}` : text
    this.cr = false
    return out
  }

  /** A control character: line ends, CR, tab and backspace are text; ESC, CAN, SUB and the C1 controls change the
   *  state; the rest show nothing. */
  private control(code: number): string {
    switch (code) {
      case 0x84: // IND and NEL end any sequence, as every C1 control does
      case 0x85:
        this.state = "ground"
        return this.newline()
      case 0x0a: // LF, and VT and FF, which move down a line as LF does
      case 0x0b:
      case 0x0c:
        return this.newline()
      case 0x0d:
        this.cr = true
        return ""
      case 0x09:
        return this.text("\t")
      case 0x08:
        return this.text("\b")
    }
    this.introduce(code)
    return ""
  }

  /** A line end, which settles a held CR as part of it. */
  private newline(): string {
    this.cr = false
    return "\n"
  }

  /** The state an ESC, CAN, SUB or C1 control leads to, from any state: the C1 introducers start their sequence,
   *  and CAN, SUB, ST and every other C1 control end any sequence. */
  private introduce(code: number): void {
    if (code === 0x1b) this.state = "escape"
    else if (code === 0x9b) this.state = "csi"
    else if (code === 0x9d) this.state = "osc"
    else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) this.state = "string"
    else if (code === 0x18 || code === 0x1a || code >= 0x80) this.state = "ground"
  }

  /** One character inside an escape, a CSI or a string. */
  private inside(code: number): string {
    if (code === 0x1b || code === 0x18 || code === 0x1a || (code >= 0x80 && code <= 0x9f)) return this.control(code)
    if (this.state === "osc" || this.state === "string") {
      if (this.state === "osc" && code === 0x07) this.state = "ground"
      return ""
    }
    if (code < 0x20) return this.control(code)
    if (code === 0x7f) return ""
    // A character past ASCII ends a sequence that can't hold it, and shows.
    if (code > 0x7f) {
      this.state = "ground"
      return this.text(String.fromCharCode(code))
    }
    if (this.state === "escape") {
      // ESC D and ESC E, the 7-bit IND and NEL.
      if (code === 0x44 || code === 0x45) {
        this.state = "ground"
        return this.newline()
      }
      if (code <= 0x2f) this.state = "intermediate"
      else if (code === 0x5b) this.state = "csi"
      else if (code === 0x5d) this.state = "osc"
      else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) this.state = "string"
      else this.state = "ground"
    } else if (this.state === "intermediate") {
      if (code >= 0x30) this.state = "ground"
    } else if (code >= 0x40) {
      this.state = "ground"
    }
    return ""
  }
}

/** Line ends, CRs and backspaces in a `PlainText`'s text. */
const LINE_CONTROL = /[\n\r\b]/g

/** Whether `code` is the first half of a surrogate pair. */
const highSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** Whether `code` is the second half of a surrogate pair. */
const lowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** `line` without its last character. */
function dropLast(line: string): string {
  const pair = lowSurrogate(line.charCodeAt(line.length - 1)) && highSurrogate(line.charCodeAt(line.length - 2))
  return line.slice(0, pair ? -2 : -1)
}

/** How much of a view's text stays in memory, in UTF-16 code units: the last 4 Mi, 4 MiB of ASCII. A long ssh
 *  session would otherwise grow without limit; the shell's record keeps all of it. */
export const VIEW_KEEP = 4 * 1024 * 1024

/** The default page size, when a caller gives none, in UTF-16 code units: 64 Ki. */
export const PAGE_SIZE = 64 * 1024

/** How far past `VIEW_KEEP` a view grows before it trims back to it, so a busy shell copies its tail once a
 *  mebi-unit, not on every chunk. */
const VIEW_SLACK = VIEW_KEEP / 4

/** One page of a view: its text, where the next page starts, whether more follows, and, when the page was asked
 *  for text no longer in memory, a sentence saying so. */
export interface Page {
  output: string
  next: number
  more: boolean
  skipped?: string
}

/** The model's view of one shell: the screen's text, as it is, with offsets.
 *
 *  Offsets count UTF-16 code units of the view's text from the shell's start, and stay so once older text leaves
 *  memory (past `VIEW_KEEP`). The finished lines never change; the last, unfinished line (a prompt, a progress bar)
 *  can still be redrawn, so a page never ends inside it: it stops at the line's start or holds the line whole, and
 *  then its `next` is that line's start. The next page shows the line again, as it then is, and never a stale or
 *  lost piece of it. */
export class ModelView {
  private readonly plain = new PlainText()
  /** How much text, from the start, is no longer in memory. */
  private dropped = 0
  /** The finished lines in memory, each with its newline. */
  private done = ""
  /** The last, unfinished line. */
  private line = ""
  /** A lone CR came: the next text written starts the line over. */
  private redraw = false

  /** Adds a chunk of the terminal's output, decoded. */
  append(raw: string): void {
    const text = this.plain.push(raw)
    let at = 0
    while (at < text.length) {
      LINE_CONTROL.lastIndex = at
      const found = LINE_CONTROL.exec(text)
      const end = found ? found.index : text.length
      if (end > at) this.write(text.slice(at, end))
      if (!found) break
      const control = text[end]
      if (control === "\n") {
        this.done += `${this.line}\n`
        this.line = ""
        this.redraw = false
      } else if (control === "\r") {
        this.redraw = true
      } else if (!this.redraw) {
        // A backspace erases the character before it, as the tty's echo of an erase (`\b \b`) shows it.
        this.line = dropLast(this.line)
      }
      at = end + 1
    }
    this.trim()
  }

  /** The text from `from` (an earlier page's `next`, or 0; a negative one is 0), at most `max` code units of it
   *  (`PAGE_SIZE` when `max` is missing or under 1), and whether more follows. A page is never cut silently, nor
   *  inside a character: `more` says there is more to read from `next`, and `skipped` says when text from `from`
   *  on is no longer in memory, so the page starts at the oldest kept.
   *
   *  A page never ends inside the unfinished last line: it stops at that line's start, and a page that reaches the
   *  end gives that start as `next`, whatever its own start. Only a line longer than a page is cut, where it must. */
  page(from: number, max: number = PAGE_SIZE): Page {
    const at = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0
    const size = Number.isFinite(max) && max >= 1 ? Math.floor(max) : PAGE_SIZE
    const length = this.length
    const lineStart = this.dropped + this.done.length
    const start = Math.min(Math.max(this.dropped, at), length)
    let end = Math.min(length, start + size)
    if (start < lineStart && end > lineStart && end < length) end = lineStart
    else if (end > start && end < length && highSurrogate(this.codeAt(end - 1))) end = end - 1 > start ? end - 1 : end + 1
    const more = end < length
    const page: Page = { output: this.slice(start, end), next: more ? end : lineStart, more }
    if (at < this.dropped)
      page.skipped = `Output before offset ${this.dropped} is no longer in memory; the shell's record keeps all of it.`
    return page
  }

  /** The length of the view's text, from the shell's start. */
  get length(): number {
    return this.dropped + this.done.length + this.line.length
  }

  /** Text on the unfinished line, which starts over after a lone CR. */
  private write(text: string): void {
    if (this.redraw) this.line = ""
    this.redraw = false
    this.line += text
  }

  /** Drops the oldest text once more than `VIEW_KEEP` and its slack is held, keeping the last `VIEW_KEEP`. */
  private trim(): void {
    let cut = this.done.length + this.line.length - VIEW_KEEP
    if (cut <= VIEW_SLACK) return
    if (cut < this.done.length) {
      if (lowSurrogate(this.done.charCodeAt(cut))) cut += 1
      this.done = this.done.slice(cut)
    } else {
      // The unfinished line alone is over the cap: its head goes too.
      let head = cut - this.done.length
      if (lowSurrogate(this.line.charCodeAt(head))) head += 1
      cut = this.done.length + head
      this.done = ""
      this.line = this.line.slice(head)
    }
    this.dropped += cut
  }

  /** The code unit at `index` (an offset from the shell's start) of the view's text. */
  private codeAt(index: number): number {
    const at = index - this.dropped
    const cut = this.done.length
    return at < cut ? this.done.charCodeAt(at) : this.line.charCodeAt(at - cut)
  }

  /** The view's text from `start` to `end`, offsets from the shell's start, both in memory. */
  private slice(start: number, end: number): string {
    const [from, to] = [start - this.dropped, end - this.dropped]
    const cut = this.done.length
    if (to <= cut) return this.done.slice(from, to)
    if (from >= cut) return this.line.slice(from - cut, to - cut)
    return this.done.slice(from) + this.line.slice(0, to - cut)
  }
}
