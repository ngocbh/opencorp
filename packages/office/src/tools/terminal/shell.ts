/** The terminal instrument's shell: an interactive bash on a PTY, with no line editing, aliases, brace expansion, job
 *  control or history, which an agent and the owner share.
 *
 *  **What the model sees** is the screen as it is (`ModelView`), and the record keeps it. The owner's keys go
 *  straight to the running command; what the terminal echoes of them is screen output like any other, and input it
 *  doesn't echo, as at a password prompt, is in no output, so it reaches no view, record or log. The shell keeps no
 *  copy of the owner's keys and logs nothing. Only the echo of the line the host types for the agent is cut, with
 *  `$ <command>` in its place.
 *
 *  **Where a command ends.** The host types the agent's command as `\__oc_b <start>; eval '<command>'; \__oc_s
 *  <nonce> $?`, with a fresh start token and nonce for each command. `__oc_b` prints a start marker with the start
 *  token: the shell has read the line. `__oc_s` sets `__oc_n` to the nonce and keeps the command's exit code; the
 *  `PROMPT_COMMAND` the shell's set-up line installs then puts the terminal's line settings back as they were at the
 *  start, prints a marker (an OSC holding `__oc_n`, the exit code, whether it drained the terminal and the next
 *  prompt's nonce) and clears `__oc_n`. Only a marker with the command's nonce ends it.
 *  - The nonce is in no variable, `PS1` or environment while the command runs, or between commands: it reaches the
 *    shell in the typed line's last call, which runs once the command has. The shell reads the whole line before it
 *    runs any of it, so nothing of it is left for the command to read as input.
 *  - `__oc_s`, the prompt's function and `PROMPT_COMMAND` are read-only, and they run `stty`, `printf` and `sh` by
 *    path and no builtin, so a command can't redefine, unset or shadow them.
 *  - The line settings come back before each marker, so a command's `stty eof ';'` can't split the next typed line.
 *  - `eval` takes a command whatever its syntax: one that doesn't parse fails and still ends.
 *  - A nonce or start token the shell prints (with `set -x`, say) is neutralised in the views, even split across
 *    reads.
 *  - Each marker carries the shell's folder as the kernel has it (`pwd -P`, by path), not as `$PWD` says, for the
 *    gate (`cwd`). Only a marker with the agent's nonce sets it: after any other end, the owner's command or one a
 *    Ctrl-C stopped, the folder is unknown until the agent's next command ends. A command that can forge its end
 *    (below) can forge that marker's folder too.
 *
 *  Without `PROMPT_COMMAND` (another sh), the typed line puts the settings back and prints the marker itself, and `PS1`
 *  is a prompt's marker. A prompt's marker is the shell back at its prompt: the end of the owner's command, and of the
 *  agent's once a Ctrl-C has reached it (a Ctrl-C stops the rest of the line).
 *
 *  **A prompt's nonce.** A prompt's marker has no command's nonce, so it carries the prompt's own: each marker names
 *  the nonce the shell's next prompt will carry, 8 bytes from `/dev/urandom` (`od`, by path) that the shell keeps in
 *  `__oc_q`, and the office takes a prompt's marker only with the nonce the marker it last took named. That nonce is
 *  in no environment, and the shell prints it only in its markers (the prompt's trace goes nowhere, and a command that
 *  prints it shows `[nonce]`), so no program the shell runs, the agent's or the owner's, can know it. Code the shell
 *  runs itself can read it: the agent's command, which can use it only to forge the prompt after a Ctrl-C has reached
 *  it, as the office takes no other prompt while that command runs and its end names a fresh nonce; the owner's
 *  command; and a function or trap a command leaves, which changes how the shell runs and so can forge any marker, as
 *  a DEBUG trap can a command's end. A marker the office can't take changes nothing: the owner's command still runs,
 *  their line stays held, the drain still waits, and the agent waits with them. A shell that loses its prompt (`exec
 *  sh`) shows none the office can take, so it stays running until it is closed; a sub-shell's prompts never end the
 *  command that started it.
 *
 *  The marker keeps the record's boundaries and exit codes, and the gate's folder, honest; it isn't a wall. The shell
 *  holds the typed line, nonce and all, while it runs it, so a command that changes how the shell runs it can still
 *  forge its end and its folder (a DEBUG trap sees the line, in `BASH_COMMAND`) or hide it (a command that hides it
 *  leaves the shell running until it is closed), and a command that outlives a Ctrl-C can forge the prompt after it
 *  with the nonce it read. The sandbox is the security boundary. The owner's own command can end early by printing
 *  its prompt's marker.
 *
 *  **An unfinished line** the agent leaves when its command ends is killed (Ctrl-U), so neither the next command nor
 *  the owner's next line takes it on; a line the owner typed after it on the same line goes with it.
 *
 *  **Stopping the agent's command.** Its interrupt, and a cut-off call's stop, send Ctrl-C only once the start marker
 *  says the shell has read the command's line: a Ctrl-C before that would make the terminal throw the unread line away,
 *  so whether the command ran at all would depend on timing. A Ctrl-C that comes as the command starts can still be
 *  dropped (bash ignores one that comes while it waits on a child that exits normally), so it goes again, up to three
 *  times, while the command runs on. The owner's keys go straight to the terminal.
 *
 *  **The owner's line.** A line the owner is part-way through holds the shell for them: the agent's commands, keys and
 *  interrupt are refused until Enter runs it or Ctrl-C gives it back. Ctrl-D gives back only an empty line: part-way
 *  through one, it hands the text on unended. At bash's own prompt, where nothing runs, the terminal reads whole lines
 *  with the line settings the prompt put back, so the office knows what the keys do there: when every key since the
 *  last Enter or Ctrl-C was typed there, Ctrl-U (the kill key) gives the line back, and so does deleting it, counted
 *  from the keys: printable characters add their bytes and Backspace (DEL, the erase key) takes one off, until an
 *  arrow, Tab or other control key makes the count unknown. A key typed anywhere else (into a running command, over
 *  ssh, at a secret prompt, or in sh, whose prompt keeps the owner's own line settings) may reach a program, or the
 *  shell, as it is, so only Enter or Ctrl-C frees that line; a Ctrl-C at the prompt once the shell prompts again, as
 *  it drops what it read of the line then. Nothing the owner left joins the agent's next command, or runs before it:
 *  after their keys on the idle shell's line (but for a line their Enter sent), it goes after a kill (Ctrl-U). Keys
 *  typed anywhere else may reach the shell later as they are, whole lines among them (a raw program leaves them
 *  queued, Enter and Ctrl-C as plain bytes), past a kill's reach, as turning whole lines back on hands them to the
 *  shell. For those the office makes the drain flag, a file in the shell's temp folder, before it writes the key; the
 *  shell's next prompt (bash's prompt function, sh's prompt and the agent's typed line) removes it and reads and drops
 *  everything the terminal holds, before the shell reads a line, and its marker says it drained. The agent's next
 *  command waits for a marker that says so; without one in 2 s the shell stays the owner's until one does. A flag that
 *  is gone proves nothing, as a command or a process it left can remove it: the prompt then drains nothing, its marker
 *  says so, and the office makes the flag again. Only a prompt's marker the office takes (its nonce) can say it
 *  drained. The owner's type-ahead on the idle line is never dropped. Neither the
 *  kill nor the drain goes into a running program. The shell's state says when the owner holds it (`ownerTyping`).
 *
 *  **Secret prompts.** While a command runs, the shell checks `ownerPrompt` after each output chunk and every 200 ms.
 *  At a secret prompt (a password, passphrase or code) it waits for the owner and refuses the agent's keys and its
 *  interrupt, in every mode; so does a line the owner is part-way through. Should the prompt end while the owner is
 *  part-way through their answer (the program timed out, or turned echo back on), the shell kills that line and drops
 *  the owner's keys until their Enter, saying so in the view, so a partial password never reaches a shell prompt or
 *  the record. Every other prompt, ssh's host-key question and Duo's menu among them, is the mode's to decide.
 *
 *  **What isn't guarded yet.** A password the owner types at a secret prompt can be read by other processes the agent
 *  started in the same terminal: a background process left over from an earlier command that reads the terminal, a
 *  process that traces the shell or ssh (ptrace), or a fake prompt the agent's command prints itself. Nothing in the
 *  shell stops that yet: only the commands the session lets run stand in the way. In ask mode the owner approves each
 *  command; in default mode, each one past the rules and the known read-only forms; in auto and dontAsk, the rules
 *  and Auto's check decide, and no one reads a command for this. */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Instrument } from "@opencorp/protocol"
import type { PtyProcess } from "../../platform.ts"
import { type OwnerPrompt, ownerPrompt } from "./guards.ts"
import { ModelView, PlainText } from "./output.ts"
import type { InstrumentRecord } from "./record.ts"

/** A shell's state, as its host lists it. `command` is the agent's command while it runs, never the owner's.
 *  `ownerTyping` says a line the owner is part-way through, or their Ctrl-C whose prompt hasn't come, holds the idle or
 *  running shell, which they can give back: never at a secret prompt, or while the rest of a line is dropped, which
 *  hold it on their own terms. */
export interface ShellState {
  status: Instrument["status"]
  waiting: OwnerPrompt | null
  command: string | null
  exit: number | null
  error: string | null
  ownerTyping: boolean
}

/** What a call on the shell returns: its state, and a page of the model's view from where the call started. `next`
 *  is where the agent reads on from; `refused` says why nothing was done; `skipped`, that the page's start is no
 *  longer in memory. */
export interface Reply {
  shell: string
  status: ShellState["status"]
  exit: number | null
  waiting: OwnerPrompt | null
  output: string
  next: number
  more: boolean
  refused?: string
  skipped?: string
}

/** What a shell's host binds: how its PTY starts, its env, its record, and where its state and live output go. */
export interface ShellHost {
  /** Starts argv on a PTY: `startOnTerminal` with the host's profile, or `spawnPty` in tests. */
  start(
    argv: readonly string[],
    io: { cols: number; rows: number; env: Record<string, string>; onData(chunk: Uint8Array): void },
  ): PtyProcess
  /** The shell's environment (`scrubbedEnv` and `TERM` in the sandbox), which the shell clears of what would run code
   *  or set options at its start. */
  env: Record<string, string>
  record: InstrumentRecord
  /** Who runs the agent's commands, as the record names them: the agent's handle. */
  driver: string
  /** Called on every state change, for the host's `instrument.updated`. */
  changed(state: ShellState): void
  /** The raw bytes, the wrapper's echo cut and `$ <command>` put in, for the owner's live view only. */
  output(chunk: Uint8Array): void
  /** Which shell: bash where `/bin/bash` exists, else sh. */
  shell?: "bash" | "sh"
}

/** The longest line the host types, in bytes. Linux cuts a typed line past 4095 bytes. */
const LINE_MAX = 1000
const LONG_LINE =
  "a line of this command is over 1000 bytes; a terminal cuts longer lines (Linux keeps 4095 bytes, macOS 1024): " +
  "write a script with the file tools and run it"
const SECRET = "the program is asking for a password; only the owner types it. Call read to see what happens next."
const OWNER_TYPING =
  "the owner is typing a line in this shell, which holds it for them until Enter runs it or Ctrl-C gives it back to " +
  "you; at the shell's prompt, Ctrl-U or deleting what they typed gives it back too. Call read, and try again once " +
  "they have; if they seem to have stopped, tell them how to give it back"
const OWNER_SECRET = "the shell is waiting for the owner at a prompt for a secret; only they can answer or stop it"
/** What the owner's live view and the model's say when a secret prompt ends under the owner's answer. */
const DROPPED_NOTE =
  "\r\n[the prompt ended while you were typing: the rest of that line is dropped until you press Enter]\r\n"
/** What a kill (Ctrl-U) echoes, whatever the line settings: erasures, or `^U` and a line end. */
const KILL_ECHO = "\b ^U\r\n"
/** The owner's keys that end their line (Enter, Ctrl-C; Ctrl-D only an empty one), kill it (Ctrl-U), and take a byte
 *  off it at the prompt (Backspace, which terminals send as DEL, the terminal's erase key; Ctrl-H isn't). */
const LINE_ENDS = new Set(["\r", "\n", "\x03", "\x04"])
const EOF = "\x04"
const KILL = "\x15"
const ERASE = "\x7f"

/** A marker: the OSC the shell prints at its prompt, with the agent's command's nonce (the prompt's own at any other
 *  prompt), the exit code, `1` when the prompt drained the terminal (`drain`), the next prompt's nonce (`NEXT`) and,
 *  but for sh's prompt, the folder. */
const MARK = "\x1b]633;opencorp-mark;"
const MARKER =
  /\x1b\]633;opencorp-mark;([^;\x07\x1b]*);([^;\x07\x1b]*)(?:;([^;\x07\x1b]*)(?:;([^;\x07\x1b]*)(?:;([^\x07\x1b]*))?)?)?\x07/g
/** The first marker, which says the shell is ready. */
const READY = new RegExp(MARKER.source)
/** The longest folder a marker reports, in bytes: Linux's `PATH_MAX`. A longer one is unknown. */
const FOLDER_MAX = 4096
/** How far past `MARK` a marker runs: a nonce, a `;`, an exit code, a `;`, whether the prompt drained, a `;`, the next
 *  prompt's nonce, a `;` and the folder. */
const MARK_TAIL = 64 + FOLDER_MAX
/** Makes the next prompt's nonce in the shell and prints it: 8 bytes of `/dev/urandom` as a signed decimal, read by
 *  `od` by path. Arithmetic expansion's assignment keeps it in `__oc_q`, the one way sh's prompt can assign; a read
 *  that fails makes 0, which names no prompt. */
const NEXT = '$((__oc_q = $({ "$__oc_o" -An -N8 -td8 /dev/urandom; } 2>/dev/null) + 0))'
/** A prompt's nonce, as `NEXT` prints it; 0 is a read that failed. */
const PROMPT_NONCE = /^-?[1-9]\d{0,19}$/
/** What a command's output shows in place of the nonce. */
const NONCE_SHOWN = "[nonce]"

/** `s` as one sh word. */
const shQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

/** While the drain flag (`__oc_d`) exists: removes it, then reads, with no wait, and drops whatever keys the terminal
 *  holds, whole lines or not, and prints `1` for the marker; nothing when there was no flag to remove. `around` keeps
 *  the line settings it finds, for a prompt that doesn't put its own back. It runs in the marker's own command
 *  substitution, so nothing a command sets can make it say it drained. */
const drain = (around = false): string =>
  `"$__oc_u" "$__oc_d" 2>/dev/null && { ${around ? '__oc_g=$("$__oc_y" -g </dev/tty); ' : ""}` +
  `"$__oc_y" -icanon min 0 time 0 </dev/tty 2>/dev/null; "$__oc_c" </dev/tty >/dev/null 2>&1; ` +
  `${around ? '"$__oc_y" "$__oc_g" </dev/tty 2>/dev/null; ' : ""}"$__oc_f" 1; }`

/** The set-up line a `kind` shell types first, its echo cut with everything else before the first marker. `flag` is
 *  the drain flag: while it exists, the next prompt (`drain`) removes it and first empties the terminal of the keys it
 *  holds. */
function setupLine(kind: "bash" | "sh", flag: string): string {
  const flagged = `__oc_d=${shQuote(flag)}; `
  if (kind === "bash") {
    // The prompt's work runs in read-only functions that call programs by path and no builtin (a command can shadow
    // `return`, `builtin` or `printf` with a function); the start's line settings are saved for each prompt to
    // restore, after its drain. The prompt prints the nonce it carries before it makes the next, and its trace (a
    // command's `set -x`) goes nowhere, as it holds both.
    return (
      "set +B +m +o history; shopt -u expand_aliases; unalias -a; set +o emacs +o vi; PS1=; PS2=; " +
      `__oc_y=$(type -P stty); __oc_f=$(type -P printf); __oc_w=$(type -P pwd); __oc_t=$("$__oc_y" -g </dev/tty); ` +
      `__oc_u=$(type -P rm); __oc_c=$(type -P cat); __oc_o=$(type -P od); ${flagged}` +
      "readonly __oc_y __oc_f __oc_w __oc_t __oc_u __oc_c __oc_o __oc_d; " +
      `__oc_b() { "$__oc_f" "\\033]633;opencorp-mark;%s;start\\007" "$1" >/dev/tty; }; ` +
      `__oc_s() { __oc_n=$1; /bin/sh -c 'exit "$1"' sh "$2"; }; ` +
      `__oc_p() { "$__oc_f" "\\033]633;opencorp-mark;%s;%d;%s;%s;%s\\007" "\${__oc_n:-\${__oc_q-}}" "$1" ` +
      `"$(${drain()}; "$__oc_y" "$__oc_t" </dev/tty 2>/dev/null)" "${NEXT}" "$("$__oc_w" -P 2>/dev/null)" ` +
      ">/dev/tty; __oc_n=; } 2>/dev/null; " +
      `readonly -f __oc_b __oc_s __oc_p; PROMPT_COMMAND='__oc_p "$?"'; readonly PROMPT_COMMAND\n`
    )
  }
  // sh's set may not know some of these options, and a special builtin's error would end the line, so each goes
  // last, alone and through `command`. A sh that is bash edits lines unless told not to. The marker's printf, pwd and
  // od run by path where they are found, so a command's function can't stand in for them. The prompt expands its
  // nonce, then its drain, each time, after the exit code it reports and before it shows, and then makes the next;
  // what it runs leaves no trace (a command's `set -x`).
  return (
    `PS1="$(printf '\\033]633;opencorp-mark;')"'\${__oc_q-};$?;$({ ${drain(true)}; } 2>/dev/null);${NEXT}'` +
    `"$(printf '\\007')"; ` +
    "PS2=; set +m; unalias -a; " +
    `__oc_y=$(command -v stty); __oc_t=$("$__oc_y" -g </dev/tty); ` +
    `__oc_u=$(command -v rm); __oc_c=$(command -v cat); __oc_o=$(command -v od); ${flagged}` +
    "__oc_f=/usr/bin/printf; [ -x $__oc_f ] || __oc_f=printf; " +
    "__oc_w=/bin/pwd; [ -x $__oc_w ] || __oc_w=/usr/bin/pwd; " +
    "readonly __oc_y __oc_t __oc_f __oc_w __oc_u __oc_c __oc_o __oc_d; " +
    "for o in '+o emacs' '+o vi' +B '+o history'; do command set $o 2>/dev/null; done; " +
    "command shopt -u expand_aliases 2>/dev/null\n"
  )
}
const ARGV = { bash: ["/bin/bash", "--noprofile", "--norc", "--noediting", "-i"], sh: ["/bin/sh", "-i"] }
/** Variables the shell never takes from its host: they would run code at its start or turn options back on. */
const DROPPED = new Set(["ENV", "BASH_ENV", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS"])

/** How often a running command's screen is checked for a secret prompt, beside after each chunk of its output. */
const GUARD_MS = 200
/** Two of those checks: how long a command gets to show a secret prompt before a reply a steer ends early. */
export const PROMPT_CHECK_MS = 2 * GUARD_MS
/** How long a Ctrl-C to the agent's command waits for its end before it goes again, and how many times it does: bash
 *  drops a Ctrl-C that comes while it waits on a child that then exits normally, as at the command's start. */
const CTRL_C_AGAIN_MS = 300
const CTRL_C_AGAIN = 3
const START_MS = 15_000
/** How long the agent's command waits for a prompt that drops what the owner left (`drained`). */
const DRAIN_MS = 2_000
const HANGUP_MS = 2_000
/** The longest a reply waits, whatever it is asked. */
const WAIT_MAX_MS = 10 * 60_000

/** A control character a command can't hold: all but newline and tab. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
/** A key that is no printable character: the terminal or the program edits the line with it. */
const KEY_CONTROL = /[\x00-\x1f\x7f-\x9f]/
/** The bytes of a command's nonce, 16 hex digits. */
const NONCE_BYTES = 8

/** Which shell a PTY shell runs: `choice`, or bash where `/bin/bash` exists, else sh. */
export function shellKind(choice?: "bash" | "sh"): "bash" | "sh" {
  return choice ?? (fs.existsSync("/bin/bash") ? "bash" : "sh")
}

/** The line the host types for the agent's `command` in a `kind` shell, with `start` and `nonce`. In sh its end makes
 *  the nonce of the prompt that follows, with its trace going nowhere, as bash's prompt does. */
function typedLine(command: string, start: string, nonce: string, kind: "bash" | "sh"): string {
  const quoted = `'${command.replaceAll("'", "'\\''")}'`
  return kind === "bash"
    ? `\\__oc_b ${start}; eval ${quoted}; \\__oc_s ${nonce} $?\n`
    : `"$__oc_f" '\\033]633;opencorp-mark;%s;start\\007' ${start} >/dev/tty; eval ${quoted}; __oc_r=$?; ` +
        `{ "$__oc_f" '\\033]633;opencorp-mark;%s;%d;%s;%s;%s\\007' ${nonce} "$__oc_r" ` +
        `"$(${drain()}; "$__oc_y" "$__oc_t" </dev/tty 2>/dev/null)" "${NEXT}" "$("$__oc_w" -P 2>/dev/null)" ` +
        ">/dev/tty; } 2>/dev/null\n"
}

/** `env` for the shell: its prompts empty, no history file, and nothing that runs code or sets options at its start. */
function shellEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!DROPPED.has(key) && !key.startsWith("BASH_FUNC_") && !key.startsWith("__oc_")) out[key] = value
  }
  return { ...out, PS1: "", PS2: "", HISTFILE: "/dev/null" }
}

/** Where a possible marker starts at the end of `text`, held back for the next chunk; -1 when there's none. */
function heldFrom(text: string): number {
  const at = text.lastIndexOf("\x1b")
  if (at < 0 || text.length - at > MARK.length + MARK_TAIL) return -1
  const tail = text.slice(at)
  if (tail.length <= MARK.length) return MARK.startsWith(tail) ? at : -1
  return tail.startsWith(MARK) && !/[\x07\x1b]/.test(tail.slice(1)) ? at : -1
}

/** A marker's folder (its bytes, one char each) as text; null when it isn't an absolute path the gate can read: over
 *  `FOLDER_MAX` bytes, not UTF-8, or holding a control character. */
function folderOf(raw: string | undefined): string | null {
  if (raw === undefined || raw.length > FOLDER_MAX) return null
  const folder = Buffer.from(raw, "latin1").toString("utf8")
  return folder.startsWith("/") && !/[\x00-\x1f\x7f-\x9f\ufffd]/.test(folder) ? folder : null
}

/** The next prompt's nonce a marker names; null when it names none (a read that failed, or an older form). */
function promptNonce(raw: string | undefined): string | null {
  return raw !== undefined && PROMPT_NONCE.test(raw) ? raw : null
}

/** `view`'s text from `from` to its end, at most its last `max` characters, where that text starts, and `cursor`. */
export function peekView(
  view: ModelView,
  from: number,
  max: number,
  cursor: number,
): { output: string; start: number; cursor: number } {
  const end = view.length
  const start = Math.min(end, Math.max(0, from, end - Math.max(0, max)))
  return { output: start < end ? view.page(start, end - start).output : "", start, cursor }
}

/** `text`'s UTF-8 bytes as a string of one char per byte, as the shell's output is parsed. */
const bytesOf = (text: string): string => Buffer.from(text, "utf8").toString("latin1")

/** A shell on a PTY that an agent drives and its owner can type into. */
export class PtyShell {
  private pty: PtyProcess | null = null
  private readonly view = new ModelView()
  private readonly decoder = new TextDecoder()
  private current: ShellState = {
    status: "starting", waiting: null, command: null, exit: null, error: null, ownerTyping: false,
  }
  /** The agent's running command's nonce. */
  private nonce: string | null = null
  /** The nonce the shell's next prompt carries, as the last marker the office took named it; null when none did. */
  private nextNonce: string | null = null
  /** Its start token, and whether its start marker has come: the shell has read its line. */
  private startToken: string | null = null
  private begun = false
  /** A Ctrl-C for it waits for its start marker. */
  private stopWanted = false
  /** The Ctrl-C to it that goes again if it hasn't ended. */
  private again: ReturnType<typeof setTimeout> | undefined
  /** The owner's command runs: one they started at the prompt. */
  private ownerRunning = false
  /** A Ctrl-C reached the agent's command: the shell's prompt ends it, nonce or not. */
  private interrupted = false
  /** The echo still to cut of the line the host typed, as bytes, and how much of it has come. */
  private echo: string | null = null
  private echoAt = 0
  /** A possible marker's start, held back for the next chunk, and how many guard checks it has waited. */
  private held = ""
  private heldChecks = 0
  /** What the shell keeps of the owner's keys, with the next three: how many bytes of printable text their line holds,
   *  as their keys at the prompt say; whether a control key there has made that count unknown; and whether a key went
   *  anywhere but bash's idle prompt, where only Enter or Ctrl-C frees the line. */
  private ownerBytes = 0
  private ownerUnknown = false
  private ownerElsewhere = false
  /** The owner has typed at the prompt since its last kill or their Enter there: the agent's next command goes after a
   *  kill. */
  private killFirst = false
  /** The owner has typed while the shell wasn't at its idle prompt reading whole lines: the agent's next command waits
   *  for a prompt whose marker says it drained the terminal. */
  private strayKeys = false
  /** The owner's Ctrl-C reached the idle shell, which drops what it read of their line as it prompts again: until that
   *  prompt, the agent's line could go with it. */
  private promptDue = false
  /** Those keys went to a secret prompt. */
  private ownerAtSecret = false
  /** A secret prompt ended under the owner's answer: their keys are dropped until their Enter. */
  private dropping = false
  /** What the agent typed without Enter since its last Enter, Ctrl-C or an owner key. */
  private agentLine = ""
  /** The terminal's line may hold what the agent typed without Enter, owner keys after it or not. */
  private agentDirty = false
  /** A kill (Ctrl-U) was sent since the last typed line: its echo may come before that line's. */
  private killSent = false
  /** sh's prompt marker is still to come after the agent's line printed its own. */
  private promptAfter = false
  /** Where the agent reads on from: the last reply's `next`. */
  private cursor = 0
  /** What came before the shell was ready, as bytes. */
  private startup = ""
  private ready: (() => void) | null = null
  private guardTimer: ReturnType<typeof setInterval> | null = null
  private readonly waiters = new Set<() => void>()
  /** How many secret prompts have held the shell: a reply's wait ends when one begins. */
  private holds = 0
  /** The folder the agent's last command ended in, as its marker said; null when unknown. */
  private folder: string | null = null
  /** Settles once the shell's process has ended and the shell has taken its exit (or it never started). */
  private ended: Promise<void> = Promise.resolve()

  /** The drain flag, in the shell's temp folder (its home without one), and the set-up line that names it. */
  private readonly flag: string
  private readonly setup: string

  private constructor(
    readonly id: string,
    readonly name: string,
    private readonly host: ShellHost,
    private readonly kind: "bash" | "sh",
  ) {
    const dir = host.env.TMPDIR ?? host.env.HOME ?? os.tmpdir()
    this.flag = path.join(dir, `.opencorp-drain-${randomBytes(6).toString("hex")}`)
    this.setup = setupLine(kind, this.flag)
  }

  /** Starts a shell on `host`'s PTY and resolves once it is ready at its prompt, or has failed (`state().error` says
   *  why, and the record ends failed). */
  static async open(
    id: string,
    name: string,
    host: ShellHost,
    size: { cols: number; rows: number } = { cols: 80, rows: 24 },
  ): Promise<PtyShell> {
    const shell = new PtyShell(id, name, host, shellKind(host.shell))
    await shell.start(size)
    return shell
  }

  state(): ShellState {
    return { ...this.current }
  }

  /** The agent's unfinished line: what it typed without Enter since its last Enter, Ctrl-C or an owner key. */
  pendingLine(): string {
    return this.agentLine
  }

  /** The folder the shell is in: where its first prompt (bash's) or the agent's last command said it was, as the
   *  kernel has it. Null when that can't be known: sh's first prompt says nothing; a folder whose name holds a control
   *  character, isn't UTF-8 or is over 4096 bytes isn't reported; and a command that ended without the agent's nonce
   *  (the owner's, or one a Ctrl-C stopped) may have moved it. A command that changes
   *  how the shell runs it (a DEBUG trap reads the nonce in `BASH_COMMAND`) can forge the folder as it can its end. */
  cwd(): string | null {
    return this.folder
  }

  /** Runs the agent's `command` and waits for its end, a secret prompt, `waitMs` or `signal`. Refused, with nothing
   *  typed, when the shell isn't idle, the owner is part-way through a line, the command is empty or holds a control
   *  character other than newline and tab, or a line of it would be over 1000 bytes. Its record names `callId`, the
   *  yian call that ran it, when given. */
  async run(command: string, waitMs: number, signal?: AbortSignal, callId?: string): Promise<Reply> {
    let why = this.runProblem(command)
    if (why !== null) return this.refusal(why)
    if (this.strayKeys) {
      await this.drained()
      why = this.runProblem(command)
      if (why !== null) return this.refusal(why)
    }
    const nonce = randomBytes(NONCE_BYTES).toString("hex")
    const token = randomBytes(NONCE_BYTES).toString("hex")
    const typed = typedLine(command, token, nonce, this.kind)
    try {
      this.host.record.command(command, this.host.driver, callId)
    } catch (error) {
      return this.refusal(`the shell's record can't be written: ${(error as Error).message}`)
    }
    // A marker's start held back at the prompt was output after all; the echo must come first.
    this.emit(this.held)
    this.held = ""
    // From where the agent last read, so what came in between (the owner's command, say) is read once.
    const start = this.cursor
    this.nonce = nonce
    this.startToken = token
    this.begun = this.stopWanted = false
    this.interrupted = false
    if (this.killFirst) this.kill()
    this.echo = bytesOf(typed).replaceAll("\n", "\r\n")
    this.echoAt = 0
    this.emit(bytesOf(`$ ${command.replaceAll("\n", "\r\n")}\r\n`))
    this.set({ status: "running", waiting: null, command, exit: null })
    this.write(typed)
    await this.wait(waitMs, signal)
    return this.reply(start)
  }

  /** Types `text` (printable ASCII, at most 1000 bytes on a line) into the running command, with Enter when `enter`,
   *  and waits as `run` does. Refused at a secret prompt, while the owner is part-way through a line, and when
   *  nothing runs. */
  async type(text: string, opts: { enter: boolean; waitMs: number; signal?: AbortSignal }): Promise<Reply> {
    const why = this.typeProblem(text)
    if (why !== null) return this.refusal(why)
    const from = this.cursor
    this.agentLine = opts.enter ? "" : this.agentLine + text
    this.agentDirty = !opts.enter && (this.agentDirty || text !== "")
    this.write(opts.enter ? `${text}\r` : text)
    await this.wait(opts.waitMs, opts.signal)
    return this.reply(from)
  }

  /** The model's view from `from` (the last reply's `next` by default), once the running command ends, a secret
   *  prompt holds it, `waitMs` passes or `signal` aborts; at once when nothing runs. */
  async read(opts: { waitMs: number; from?: number; signal?: AbortSignal }): Promise<Reply> {
    const from = opts.from ?? this.cursor
    await this.wait(opts.waitMs, opts.signal)
    return this.reply(from)
  }

  /** Sends Ctrl-C to the agent's own running command. Refused when nothing runs, or the command is the owner's. */
  interrupt(): Reply {
    if (this.current.status === "waiting") return this.refusal(OWNER_SECRET)
    if (this.ownerHolds()) return this.refusal(OWNER_TYPING)
    if (this.nonce === null) {
      const why = this.ownerRunning ? "the running command is the owner's; only they can stop it" : "nothing is running"
      return this.refusal(why)
    }
    this.interrupted = true
    this.agentLine = ""
    this.agentDirty = false
    this.ctrlC()
    return this.reply(this.cursor)
  }

  /** Stops the agent's running command for a call cut off, as the owner's Ctrl-C would, whatever holds it (a secret
   *  prompt, a line the owner is typing): Ctrl-C once the shell has read the command's line. Nothing when no command of
   *  the agent's runs. What the shell keeps of the owner's keys stays: a secret prompt that ends under their answer
   *  drops the rest of it until their Enter, so it never reaches the shell's prompt. */
  stop(): void {
    if (this.nonce === null) return
    this.interrupted = true
    this.agentLine = ""
    this.agentDirty = false
    this.ctrlC()
  }

  /** Ctrl-C to the agent's command now if the shell has read its line, else once its start marker comes. */
  private ctrlC(): void {
    if (this.begun) this.sendCtrlC(CTRL_C_AGAIN)
    else this.stopWanted = true
  }

  /** Writes Ctrl-C, and again after `CTRL_C_AGAIN_MS`, `left` more times at most, while the same command of the
   *  agent's runs, no secret prompt holds it and the owner isn't typing a line. */
  private sendCtrlC(left: number): void {
    this.write("\x03")
    clearTimeout(this.again)
    if (left === 0) return
    const nonce = this.nonce
    this.again = setTimeout(() => {
      if (this.nonce === nonce && this.current.status === "running" && !this.ownerHolds()) this.sendCtrlC(left - 1)
    }, CTRL_C_AGAIN_MS)
  }

  /** Writes the owner's keys to the PTY, straight to the running command. The shell keeps only how far the owner's
   *  line holds the shell (the module's "The owner's line"), and whether their keys went to a secret prompt; an Enter
   *  at the prompt starts the owner's command. While a secret prompt that ended under their answer is being dropped,
   *  their keys up to their Enter go nowhere. */
  ownerKeys(data: string): void {
    const { status } = this.current
    if (status === "starting" || status === "ended" || status === "failed") return
    this.agentLine = ""
    let keys = ""
    for (const key of data) {
      const ends = LINE_ENDS.has(key)
      if (this.dropping) {
        if (ends) {
          this.dropping = false
          this.ownerLineGone()
        }
        continue
      }
      keys += key
      // A key on the idle shell's line, read whole, stays there for a kill; any other may reach the shell later as it is.
      const line = this.atIdleLine()
      const prompt = line && this.kind === "bash"
      if (line) this.killFirst = true
      else this.stray()
      if (ends) {
        this.ownerAtSecret = false
        // Ctrl-D hands a part-typed line on unended: whoever reads it holds it now.
        if (key === EOF && this.ownerLineHeld()) this.ownerElsewhere = true
        else this.ownerLineGone()
        if (key === "\x03" && this.nonce !== null) this.interrupted = true
        if (key === "\x03" && this.current.status === "idle") this.promptDue = true
        if ((key === "\r" || key === "\n") && this.current.status === "idle") {
          // The shell takes the line whole: nothing of it is left for a kill.
          if (line) this.killFirst = false
          this.ownerRunning = true
          this.set({ status: "running", waiting: null, command: null, exit: null })
        }
        continue
      }
      if (this.current.status === "waiting") this.ownerAtSecret = true
      if (!prompt) this.ownerElsewhere = true
      else if (key === KILL && !this.ownerElsewhere) {
        // The terminal kills its whole line: all of it was typed at the prompt.
        this.ownerLineGone()
        continue
      }
      if (key === ERASE) this.ownerBytes = Math.max(0, this.ownerBytes - 1)
      else if (KEY_CONTROL.test(key)) this.ownerUnknown = true
      else this.ownerBytes += Buffer.byteLength(key)
    }
    if (keys !== "") this.write(keys)
    this.set({})
  }

  /** Whether the owner's line holds the shell: they are part-way through it, the rest of it is being dropped, or the
   *  shell is still to prompt again after their Ctrl-C. */
  private ownerHolds(): boolean {
    return this.dropping || this.promptDue || this.ownerLineHeld()
  }

  /** Whether the owner is part-way through a line, as far as their keys say. */
  private ownerLineHeld(): boolean {
    return this.ownerElsewhere || this.ownerUnknown || this.ownerBytes > 0
  }

  /** The owner's line has ended or been killed: nothing of it holds the shell. */
  private ownerLineGone(): void {
    this.ownerBytes = 0
    this.ownerUnknown = this.ownerElsewhere = false
  }

  /** Whether a key goes to the idle shell's line now, which the terminal reads whole: nothing runs to read it. At
   *  bash's, whose prompt puts its line settings back, the office knows what the keys do there too. */
  private atIdleLine(): boolean {
    return this.current.status === "idle" && this.pty !== null && this.pty.modes().canonical
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows)
    } catch {
      // The terminal has closed: the shell has ended.
    }
  }

  /** Ends the shell: SIGHUP to its process group, then SIGKILL after 2 s; resolves once it has ended. */
  async close(): Promise<void> {
    const pty = this.pty
    if (pty === null || this.current.status === "ended" || this.current.status === "failed") return await this.ended
    pty.kill("SIGHUP")
    const kill = setTimeout(() => pty.kill("SIGKILL"), HANGUP_MS)
    await this.ended
    clearTimeout(kill)
  }

  private async start(size: { cols: number; rows: number }): Promise<void> {
    this.host.record.follow(this.view)
    let pty: PtyProcess
    try {
      const env = shellEnv(this.host.env)
      pty = this.host.start(ARGV[this.kind], { ...size, env, onData: (chunk) => this.onData(chunk) })
    } catch (error) {
      this.fail(`the shell couldn't start: ${(error as Error).message}`)
      return
    }
    this.pty = pty
    this.ended = pty.exited.then(
      (code) => this.onExit(code),
      () => this.onExit(null),
    )
    this.write(this.setup)
    let timer: ReturnType<typeof setTimeout> | undefined
    await new Promise<void>((resolve) => {
      this.ready = resolve
      const late = () => this.fail(`the shell wasn't ready within ${START_MS / 1000} s${this.startupTail()}`)
      timer = setTimeout(late, START_MS)
    })
    clearTimeout(timer)
  }

  /** What the PTY printed: before the shell is ready, its start-up; then the wrapper's echo is cut, markers are taken
   *  out and acted on, and the rest goes to both views. */
  private onData(chunk: Uint8Array): void {
    let text = this.held + Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("latin1")
    this.held = ""
    this.heldChecks = 0
    if (this.current.status === "starting") {
      const rest = this.started(text)
      if (rest === null) return
      text = rest
    }
    if (this.current.status === "failed") return
    text = this.cutEcho(text)
    let at = 0
    for (const match of text.matchAll(MARKER)) {
      this.emit(this.neutral(text.slice(at, match.index)))
      at = match.index + match[0].length
      this.marker(match[1]!, match[2]!, match[3] === "1", match[4], match[5])
    }
    let rest = text.slice(at)
    const hold = this.holdFrom(rest)
    if (hold >= 0) {
      this.held = rest.slice(hold)
      rest = rest.slice(0, hold)
    }
    this.emit(this.neutral(rest))
    this.guard()
  }

  /** Where the end of `text` may be cut short, to hold back for the next chunk: a marker's start, or the start of the
   *  running command's nonce or start token; -1 when it isn't. */
  private holdFrom(text: string): number {
    const marker = heldFrom(text)
    if (marker >= 0 || this.nonce === null) return marker
    for (const secret of [this.nonce, this.startToken ?? ""]) {
      for (let n = Math.min(secret.length - 1, text.length); n > 0; n--) {
        if (secret.startsWith(text.slice(-n))) return text.length - n
      }
    }
    return -1
  }

  /** Takes start-up output until the first marker: then the shell is ready, if its line editing is off (echo and
   *  whole lines on), and what followed the marker is returned. Null until then, or when the start failed. Nothing
   *  but the shell runs before it, so it names the first prompt's nonce. */
  private started(text: string): string | null {
    this.startup = (this.startup + text).slice(-64 * 1024)
    const found = READY.exec(this.startup)
    if (found === null) return null
    const rest = this.startup.slice(found.index + found[0].length)
    this.folder = folderOf(found[5])
    this.nextNonce = promptNonce(found[4])
    this.startup = ""
    const modes = this.pty!.modes()
    if (!modes.echo || !modes.canonical) {
      this.fail("the shell's line editing couldn't be turned off")
      return null
    }
    this.set({ status: "idle" })
    this.ready?.()
    return rest
  }

  /** Cuts the echo of the line the host typed from the front of `text`: exact, since the shell has no line editing.
   *  A kill's echo may come first, and stays. Other output first stops the cut, and the rest of the echo shows, as on
   *  screen, its nonce neutralised. */
  private cutEcho(text: string): string {
    if (this.echo === null) return text
    let start = 0
    if (this.echoAt === 0 && this.killSent) while (start < text.length && KILL_ECHO.includes(text[start]!)) start += 1
    let at = start
    while (at < text.length && this.echoAt < this.echo.length && text[at] === this.echo[this.echoAt]) {
      at += 1
      this.echoAt += 1
    }
    if (this.echoAt > 0) this.killSent = false
    if (this.echoAt === this.echo.length || at < text.length) this.echo = null
    return text.slice(0, start) + text.slice(at)
  }

  /** `text` with the agent's command's nonce and start token, and the next prompt's nonce, neutralised. */
  private neutral(text: string): string {
    for (const secret of [this.nonce, this.startToken, this.nextNonce]) {
      if (secret !== null && text.includes(secret)) text = text.replaceAll(secret, NONCE_SHOWN)
    }
    return text
  }

  /** A marker with `nonce`, `exitText`, whether it drained, the next prompt's nonce and the folder. With `start` for
   *  `exitText`, the start of the agent's command when it holds its start token. Else the end of the agent's command
   *  when it holds that command's nonce, or a prompt when it holds the prompt's (`nextNonce`): the end of the owner's
   *  command, or of the agent's once a Ctrl-C has reached it. A prompt while the agent's command runs is the
   *  command's own, before that: its nonce is one the command can read. Any other is ignored, its drain and next
   *  nonce with it. Only the agent's command's end sets the folder. */
  private marker(
    nonce: string,
    exitText: string,
    drained: boolean,
    next: string | undefined,
    folder: string | undefined,
  ): void {
    if (exitText === "start") return this.begin(nonce)
    const ending = this.nonce !== null && nonce === this.nonce
    const prompt = !ending && this.nextNonce !== null && nonce === this.nextNonce
    // sh's prompt after the agent's line may come once the agent's next line is typed, but always before it runs.
    if (!ending && !(prompt && (this.promptAfter || this.nonce === null || this.interrupted))) return
    this.nextNonce = promptNonce(next)
    const exit = /^-?\d+$/.test(exitText) ? Number(exitText) : null
    this.prompted(drained)
    if (prompt && this.promptAfter) {
      // sh's prompt after the agent's line, which already ended it: never the end of a command started since. The
      // owner's Ctrl-C while sh makes it starts it over, and the one prompt that comes then has a Ctrl-C's exit.
      this.promptAfter = false
      if (!(this.promptDue && exit === 130)) return
    }
    // A fresh prompt: the shell has dropped what it read of a line a Ctrl-C stopped.
    if (prompt && this.promptDue) {
      this.promptDue = false
      this.set({})
    }
    if (this.nonce !== null) {
      this.promptAfter = this.kind === "sh" && ending
      try {
        this.host.record.exit(exit)
      } catch {
        // meta.json can't be written now; the record keeps the exit for its next write.
      }
    } else if (!this.ownerRunning) return
    this.folder = ending ? folderOf(folder) : null
    this.settle()
    this.set({ status: "idle", waiting: null, command: null, exit })
  }

  /** The shell has read the agent's command's line, if `token` is its start token: a Ctrl-C that waited goes now. */
  private begin(token: string): void {
    if (this.nonce === null || token !== this.startToken || this.begun) return
    this.begun = true
    if (!this.stopWanted) return
    this.stopWanted = false
    this.sendCtrlC(CTRL_C_AGAIN)
  }

  /** Clears what a command held: its nonce and start, its echo, and the agent's unfinished line, which a kill (Ctrl-U)
   *  takes off the terminal's line too, with any owner keys after it. */
  private settle(): void {
    this.nonce = null
    this.startToken = null
    this.begun = this.stopWanted = false
    clearTimeout(this.again)
    this.ownerRunning = false
    this.interrupted = false
    this.echo = null
    this.agentLine = ""
    if (this.agentDirty) this.kill()
    this.agentDirty = false
  }

  /** Kills the terminal's unfinished line (Ctrl-U), which the prompt's line settings make the kill key. The owner's
   *  keys on it go too; whether they went to a secret prompt still counts, for `drop`. */
  private kill(): void {
    this.write(KILL)
    this.killSent = true
    this.killFirst = false
    this.ownerLineGone()
  }

  /** Holds the shell for the owner while the screen asks a secret, and lets it go once it doesn't. */
  private guard(): void {
    const { status } = this.current
    if ((status !== "running" && status !== "waiting") || this.pty === null) return
    const waiting = ownerPrompt(this.lastLine(), this.pty.modes())
    if (waiting !== this.current.waiting) this.set({ status: waiting ? "waiting" : "running", waiting })
  }

  /** The tail of the view's unfinished last line: as much as a prompt check needs. */
  private lastLine(): string {
    const length = this.view.length
    const start = Math.max(this.view.page(length).next, length - 4096)
    return length > start ? this.view.page(start, length - start).output : ""
  }

  /** Sends `text` (bytes, one char each) to the owner's live view and the model's. */
  private emit(text: string): void {
    if (text === "") return
    const bytes = Buffer.from(text, "latin1")
    this.host.output(bytes)
    this.view.append(this.decoder.decode(bytes, { stream: true }))
  }

  private write(data: string): void {
    try {
      this.pty?.write(data)
    } catch {
      // The terminal has closed: the exit settles the state.
    }
  }

  /** Updates the state, with whether the owner's line holds the shell, tells the host, runs the guard's timer while a
   *  command runs, and wakes waiting replies. */
  private set(change: Partial<ShellState>): void {
    const next = { ...this.current, ...change }
    if (next.status === "waiting" && this.current.status !== "waiting") this.holds += 1
    const dropping = this.current.status === "waiting" && next.status !== "waiting" && this.ownerAtSecret
    if (dropping && next.status !== "ended" && next.status !== "failed") this.drop()
    const live = next.status === "idle" || next.status === "running"
    next.ownerTyping = (this.ownerLineHeld() || this.promptDue) && !this.dropping && live
    const same = (Object.keys(next) as (keyof ShellState)[]).every((key) => next[key] === this.current[key])
    this.current = next
    if (same) return
    const busy = next.status === "running" || next.status === "waiting"
    if (busy && this.guardTimer === null) this.guardTimer = setInterval(() => this.check(), GUARD_MS)
    if (!busy && this.guardTimer !== null) {
      clearInterval(this.guardTimer)
      this.guardTimer = null
    }
    this.host.changed(this.state())
    this.wake()
  }

  /** Wakes the replies and flushes that wait, each to check whether its wait is over. */
  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }

  /** The owner's key goes where the shell may read it later as it is (`strayKeys`): the drain flag is made before the
   *  key is written, so any prompt that could find the key finds the flag too. It is opened without following a link,
   *  truncating, or waiting on a pipe, as the shell's commands can write its folder; a flag that can't be made leaves
   *  the agent's commands refused. */
  private stray(): void {
    this.strayKeys = true
    this.makeFlag()
  }

  /** Makes the drain flag, if it can: a flag that isn't there leaves the next prompt's marker saying it didn't drain. */
  private makeFlag(): void {
    try {
      const { O_WRONLY, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants
      fs.closeSync(fs.openSync(this.flag, O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600))
    } catch {
      // A link, pipe or folder a command put there: no prompt drains until it goes.
    }
  }

  /** A prompt the shell acts on came, its marker saying whether it drained the terminal. Only that says so: a flag that
   *  is gone may have been removed by a command, or a process it left. Without the drain, the owner's stray keys stay
   *  (the agent's next command waits), and the flag is made again for the next prompt. */
  private prompted(drained: boolean): void {
    if (!this.strayKeys) return
    if (!drained) return this.makeFlag()
    this.strayKeys = false
    this.wake()
  }

  /** Waits for a prompt that drained the terminal of the owner's stray keys, at most `DRAIN_MS`. Without one the shell
   *  may still hold them: it stays the owner's, and says so, until a prompt drains it (their Enter or Ctrl-C). */
  private async drained(): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve()
      }
      const check = () => {
        if (!this.strayKeys || this.current.status !== "idle") done()
      }
      const timer = setTimeout(done, DRAIN_MS)
      this.waiters.add(check)
      check()
    })
    if (!this.strayKeys || this.current.status !== "idle") return
    this.promptDue = true
    this.set({})
  }

  /** A secret prompt ended under the owner's answer: kills the line they were typing and drops their keys up to their
   *  Enter, telling them so. */
  private drop(): void {
    this.emit(bytesOf(DROPPED_NOTE))
    this.kill()
    this.ownerAtSecret = false
    this.dropping = true
  }

  /** The guard's timed check; a possible marker's start held through a whole check is plain output after all. */
  private check(): void {
    if (this.held !== "" && this.heldChecks++ > 0) {
      const held = this.held
      this.held = ""
      this.emit(this.neutral(held))
    }
    this.guard()
  }

  /** Resolves once the command ends (or the shell does), a secret prompt begins to hold it, `waitMs` passes or `signal`
   *  aborts; at once when nothing runs. A wait that starts while a prompt holds waits for what comes after it. */
  private wait(waitMs: number, signal?: AbortSignal): Promise<void> {
    const holds = this.holds
    const over = () => this.holds !== holds || (this.current.status !== "running" && this.current.status !== "waiting")
    return new Promise((resolve) => {
      if (over() || signal?.aborted) return resolve()
      const ms = Number.isFinite(waitMs) ? Math.min(Math.max(0, waitMs), WAIT_MAX_MS) : 0
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", done)
        this.waiters.delete(check)
        resolve()
      }
      const check = () => {
        if (over()) done()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener("abort", done)
      this.waiters.add(check)
    })
  }

  /** Why the agent's `command` can't be typed into a `kind` shell whatever its state, or null: it is empty, holds a
   *  control character other than newline and tab, or a line of it, as the host types it, would be over 1000 bytes. */
  static commandProblem(command: string, kind: "bash" | "sh"): string | null {
    if (command.trim() === "") return "the command is empty"
    if (CONTROL.test(command)) return "a command can't hold a control character other than newline and tab"
    const zeros = "0".repeat(2 * NONCE_BYTES)
    const typed = typedLine(command, zeros, zeros, kind)
    if (typed.split("\n").some((line) => Buffer.byteLength(line) > LINE_MAX)) return LONG_LINE
    return null
  }

  /** Why `run` would refuse `command` now, with nothing typed, or null: the shell isn't idle, the owner is part-way
   *  through a line, or the command can't be typed (`commandProblem`). */
  runProblem(command: string): string | null {
    const { status, error } = this.current
    if (status === "failed") return `the shell failed to start: ${error}`
    if (status === "ended") return "the shell has ended; start a new one"
    if (status === "starting") return "the shell is still starting"
    if (status === "waiting") return SECRET
    if (status === "running" && this.ownerRunning) return "the owner's command is running; call read to follow it"
    if (status === "running") {
      return "a command is still running in this shell; call read to follow it, type to answer it, or interrupt it"
    }
    if (this.ownerHolds()) return OWNER_TYPING
    return PtyShell.commandProblem(command, this.kind)
  }

  /** Why `type` would refuse `text` now, with nothing typed, or null: a secret prompt holds the shell, nothing runs,
   *  the owner is part-way through a line, or the text isn't printable ASCII or would make the line over 1000 bytes.
   *  It reads the screen as it is now, not at the last check: a read may have turned echo off since. */
  typeProblem(text: string): string | null {
    this.guard()
    const { status } = this.current
    if (status === "waiting") return SECRET
    if (status !== "running") return "nothing is running in this shell to type into; run a command"
    if (this.ownerHolds()) return OWNER_TYPING
    if (!/^[\x20-\x7e]*$/.test(text)) return "type takes printable ASCII only; interrupt sends Ctrl-C"
    if (this.agentLine.length + text.length > LINE_MAX) {
      return "a typed line would be over 1000 bytes, and a terminal cuts longer lines"
    }
    return null
  }

  /** Where the model's view ends now: where a command started here begins. */
  viewEnd(): number {
    return this.view.length
  }

  /** The model's view from `from` to its end, at most its last `max` characters, where that text starts, and where
   *  the agent reads on from; the agent's place doesn't move. */
  peek(from: number, max: number): { output: string; start: number; cursor: number } {
    return peekView(this.view, from, max, this.cursor)
  }

  /** The state and the view from `from`; the agent reads on from its `next`. */
  private reply(from: number): Reply {
    const page = this.view.page(from)
    this.cursor = page.next
    const { status, exit, waiting } = this.current
    const { output, next, more } = page
    const reply: Reply = { shell: this.id, status, exit, waiting, output, next, more }
    if (page.skipped !== undefined) reply.skipped = page.skipped
    return reply
  }

  /** A reply saying why nothing was done, with the shell's state, from where the agent last read. */
  refusal(why: string): Reply {
    const { status, exit, waiting } = this.current
    return { shell: this.id, status, exit, waiting, output: "", next: this.cursor, more: false, refused: why }
  }

  /** The shell's process has ended: what it held back is output, and the shell ends with its exit code. */
  private onExit(code: number | null): void {
    if (this.current.status === "starting") {
      this.fail(`the shell exited before it was ready${this.startupTail()}`)
      return
    }
    if (this.current.status === "failed") return
    const held = this.held
    this.held = ""
    this.emit(this.neutral(held))
    this.view.append(this.decoder.decode())
    if (this.nonce !== null) {
      try {
        this.host.record.exit(code)
      } catch {
        // As in `marker`: the record's end saves it.
      }
    }
    this.settle()
    this.unflag()
    this.set({ status: "ended", waiting: null, command: null, exit: code })
    try {
      this.host.record.end("ended")
    } catch {
      // meta.json can't be written; output.log is complete and closed.
    }
  }

  /** Removes the drain flag, a link or file in its place included, once the shell has ended. */
  private unflag(): void {
    try {
      fs.unlinkSync(this.flag)
    } catch {
      // There is none, or a folder a command made there, which goes with the temp folder.
    }
  }

  /** The shell couldn't start: it ends failed, with `error`, and its process is killed. */
  private fail(error: string): void {
    if (this.current.status !== "starting") return
    this.set({ status: "failed", error })
    this.pty?.kill("SIGKILL")
    this.pty?.close()
    try {
      this.host.record.end("failed", error)
    } catch {
      // As in `onExit`.
    }
    this.ready?.()
  }

  /** The last of what the shell printed while starting, its set-up line's echo left out, for a failure's message. */
  private startupTail(): string {
    const plain = new PlainText().push(Buffer.from(this.startup, "latin1").toString("utf8"))
    const text = plain.replaceAll(this.setup.trim(), "").trim().slice(-300)
    return text === "" ? "" : `: ${text}`
  }
}
