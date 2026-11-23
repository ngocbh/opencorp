// An agent's terminal tools in the transcript: a command as the upstream TUI's shell view (`$ <command>` in its
// shell, the command folded to two rows and its output to its end), a typed line as `⌨ <text> into <shell>`, and a
// read, interrupt or close as one line, each read from the tool's JSON reply. A reply is a snapshot, so a command it
// left running or waiting spins only while the shell still runs it.
import type { Instrument, Message, ToolPart } from "@opencorp/protocol"
import type { CapturedLine } from "@opentui/core"
import { afterAll, beforeEach, expect, test } from "bun:test"
import { DEFAULT_THEME, DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"
import { writeKV } from "../../fixture/kv"

type App = Awaited<ReturnType<typeof bootFrame>>

// These tests read each call's own row, so the transcript shows every call (High), as upstream's tests of its tool
// rows pin it; later test files expect the default.
beforeEach(() => writeKV({ session_verbosity: "high" }))
afterAll(() => writeKV({ session_verbosity: undefined }))

const AT = "2026-11-17T10:00:00.000Z"
const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")
/** Control characters other than tab and newline, which the terminal would act on. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/** A reply as the office writes it, with `fields` over an idle shell 1's. */
const reply = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    shell: "shell 1",
    status: "idle",
    exit: 0,
    waiting: null,
    output: "",
    next: 0,
    more: false,
    ...fields,
  })

let n = 0
/** A completed call of `tool` with `input` and `output`, unless `fields` say otherwise. */
const call = (
  tool: string,
  input: Record<string, unknown>,
  output: string,
  fields: Partial<ToolPart> = {},
): ToolPart => ({
  id: `p${++n}`,
  type: "tool",
  call_id: `call_${n}`,
  tool,
  state: "completed",
  input,
  output,
  ...fields,
})

/** Boots session 0 of `office` with one assistant message of `parts`, on a screen `height` rows tall. */
async function boot(parts: ToolPart[], office: FakeOffice = createFakeOffice(), height = 30) {
  const s = office.state.sessions[0]
  office.state.messages[s.id] = [
    { id: "M1", session_id: s.id, role: "assistant", created_at: AT, parts },
  ] satisfies Message[]
  const app = await bootFrame(createStub(office), { sessionID: s.id }, { width: 100, height })
  return { office, s, app }
}

/** Sets session `sid`'s shell 1 as its host lists it. A pipes shell, so a wait doesn't open it over the transcript. */
const shell1 = (office: FakeOffice, sid: string, fields: Partial<Instrument>) =>
  office.addInstrument(sid, {
    id: "01JA1H00000000000000000001",
    session_id: sid,
    kind: "terminal",
    name: "shell 1",
    driver: "minh",
    profile: "workspace",
    interactive: false,
    status: "idle",
    created_at: AT,
    updated_at: AT,
    ...fields,
  })

const text = (l: CapturedLine) => l.spans.map((s) => s.text).join("")
/** The foreground of the first span holding `needle` on the first line that has it. */
function fgOf(app: App, needle: string) {
  const line = app.setup.captureSpans().lines.find((l) => text(l).includes(needle))
  return line?.spans.find((s) => s.text.includes(needle))?.fg
}

test("a terminal command shows as $ ls in shell 1 with its output folded", async () => {
  const lines = Array.from({ length: 15 }, (_, i) => `f${String(i + 1).padStart(2, "0")}`)
  lines[14] = `\u001b[1m${lines[14]}\u001b[0m`
  const heredoc = ["cat <<'EOF' > notes.txt", ...Array.from({ length: 30 }, (_, i) => `row ${i + 1}`), "EOF"]
  const { office, app } = await boot(
    [
      call("terminal_run", { command: "ls", why: "see the files" }, reply({ output: lines.join("\n") + "\n" })),
      call(
        "terminal_run",
        { command: "make", why: "build", shell: "shell 2" },
        reply({ shell: "shell 2", exit: 2, output: "Error 2\n" }),
      ),
      call("terminal_run", { command: heredoc.join("\n"), why: "write notes", shell: "shell 1" }, reply()),
    ],
    undefined,
    60,
  )
  try {
    const f = await app.until((f) => f.includes("$ ls in shell 1") && f.includes("$ make in shell 2"))
    // The output keeps its end, after a count of the lines before it.
    expect(f).toContain("(8 earlier lines)")
    expect(f).not.toContain("f08")
    for (const kept of ["f09", "f14", "f15"]) expect(f).toContain(kept)
    expect(f).toContain("Click to expand")
    expect(f).not.toContain("[1m")
    // The exit note is the reply's exit, shown when it isn't 0.
    expect(f).toContain("$ make in shell 2 (exit 2)")
    expect(f).not.toContain("$ ls in shell 1 (exit")
    expect(f).toContain("Error 2")
    // A long command folds to two rows, its shell after it.
    expect(f).toContain("$ cat <<'EOF' > notes.txt")
    expect(f).toContain("row 1… in shell 1")
    expect(f).not.toContain("row 2")
    // The shell is named in the muted colour, apart from the command.
    expect(fgOf(app, " in shell 2")?.equals(theme.textMuted)).toBe(true)
    expect(fgOf(app, "$ make")?.equals(theme.textMuted)).toBe(false)
    // The reply's own fields never show.
    expect(f).not.toContain('"next"')
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a typed line shows as ⌨ yes into shell 1 ⏎", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addApproval(s.id, {
    kind: "input",
    tool: "terminal_type",
    action: "overwrite-all",
    args: { shell: "shell 1", text: "overwrite-all" },
    reason: "Ask mode",
  })
  const { app } = await boot(
    [
      call("terminal_type", { shell: "shell 1", text: "yes", why: "accept the licence" }, reply()),
      call("terminal_type", { shell: "shell 1", text: "n", enter: false, why: "answer no" }, reply()),
      // A newline in the text is an Enter, and shows as one, on the same row.
      call("terminal_type", { shell: "shell 1", text: "first\nsecond", why: "two answers" }, reply()),
      // The held one: yian's id for the call is the one the open card names.
      call("terminal_type", { shell: "shell 1", text: "overwrite-all", why: "replace them" }, "{}", {
        state: "running",
        yian_call_id: q.call_id!,
      }),
    ],
    office,
  )
  try {
    const f = await app.until(
      (f) => f.includes("⌨ yes into shell 1 ⏎") && f.includes("overwrite-all into shell 1 ⏎") && f.includes("△"),
    )
    // Text typed without Enter stays on the line.
    expect(f).toContain("⌨ n into shell 1")
    expect(f).not.toContain("n into shell 1 ⏎")
    expect(f).toContain("⌨ first⏎second into shell 1 ⏎")
    // The held one is drawn in the warning colour, as the card's own title is.
    const warning = fgOf(app, "△")
    expect(warning).toBeDefined()
    expect(fgOf(app, "overwrite-all into shell 1")?.equals(warning!)).toBe(true)
    expect(fgOf(app, "yes into shell 1")?.equals(warning!)).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a run waiting at a password says so while its shell waits, and stops once it doesn't", async () => {
  const office = createFakeOffice()
  const sid = office.state.sessions[0].id
  const command = "sudo apt update"
  shell1(office, sid, { status: "waiting", waiting: "secret", command })
  const { app } = await boot(
    [
      call(
        "terminal_run",
        { command, why: "refresh the package lists", shell: "shell 1" },
        reply({ status: "waiting", waiting: "secret", exit: null, output: "[sudo] password for minh: ", note: "…" }),
      ),
    ],
    office,
  )
  try {
    let f = await app.until((f) => f.includes("waiting for your password"))
    // The spinner takes the `$`, as for any command still running, in the warning colour while it waits.
    expect(f).toContain("sudo apt update in shell 1")
    expect(f).not.toContain("$ sudo apt update")
    expect(f).toContain("[sudo] password for minh:")
    expect(fgOf(app, "sudo apt update")?.equals(theme.warning)).toBe(true)
    // The owner typed it: the command runs on, no longer waiting.
    shell1(office, sid, { status: "running", command })
    f = await app.until((f) => !f.includes("waiting for your password"))
    expect(f).not.toContain("$ sudo apt update")
    expect(fgOf(app, "sudo apt update")?.equals(theme.warning)).toBe(false)
    // It ended: the call shows as it replied, with no spinner.
    shell1(office, sid, { status: "idle", command: null })
    await app.until((f) => f.includes("$ sudo apt update in shell 1"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a command its reply left running spins only while its shell still runs it", async () => {
  const office = createFakeOffice()
  const sid = office.state.sessions[0].id
  const { app } = await boot(
    [
      call(
        "terminal_run",
        { command: "sleep 99", why: "wait", shell: "shell 1" },
        reply({ status: "running", exit: null, output: "started\n" }),
      ),
      // A shell tool's stray status and shell arguments don't make it a terminal's.
      call("workspace_shell", { command: "make", status: "running", shell: "shell 9" }, "built\n"),
    ],
    office,
  )
  try {
    // No shell runs it (the office restarted, or it ended before this was read): no spinner.
    let f = await app.until((f) => f.includes("$ sleep 99 in shell 1") && f.includes("built"))
    expect(f).toContain("$ make")
    expect(f).not.toContain("shell 9")
    shell1(office, sid, { status: "running", command: "sleep 99" })
    f = await app.until((f) => f.includes("sleep 99 in shell 1") && !f.includes("$ sleep 99"))
    // Another command in the same shell isn't this one.
    shell1(office, sid, { status: "running", command: "sleep 5" })
    await app.until((f) => f.includes("$ sleep 99 in shell 1"))
    expect(app.frame()).toContain("$ make")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("reading, interrupting and closing a shell each show one line naming the shell and its status", async () => {
  const { office, app } = await boot([
    call("terminal_read", { shell: "shell 1", wait: 60 }, reply({ status: "running", exit: null, output: "50%\n" })),
    call("terminal_interrupt", { shell: "shell 1" }, reply({ exit: 130 })),
    call("terminal_close", { shell: "shell 1" }, reply({ status: "ended", exit: null })),
    call("terminal_close", { shell: "shell 3" }, JSON.stringify({ refused: "shell 3 isn't open" })),
  ])
  try {
    const f = await app.until((f) => f.includes("Close shell 3"))
    expect(f).toContain("Read shell 1 · running")
    expect(f).toContain("Interrupt shell 1 · idle")
    expect(f).toContain("Close shell 1 · ended")
    expect(f).toContain("Close shell 3 · refused: shell 3 isn't open")
    // A read's output is the model's; the line doesn't repeat it.
    expect(f).not.toContain("50%")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a terminal call's fields show no control characters", async () => {
  // An escape sequence, a bell, a backspace and a carriage return in each of its command, shell, typed text, refusal,
  // error, status and output.
  const odd = (word: string) => `${word.slice(0, 2)}\x1b[31m${word.slice(2, 4)}\x07${word.slice(4)}\x08\r`
  const { office, app } = await boot(
    [
      call(
        "terminal_run",
        { command: odd("echoing"), why: "w" },
        reply({
          shell: odd("shellA"),
          status: "failed",
          exit: null,
          output: `${odd("output")}next`,
          error: odd("crashed"),
        }),
      ),
      call("terminal_type", { shell: "shell 1", text: odd("yessir"), why: "w" }, reply({ refused: odd("blocked") })),
      call("terminal_read", { shell: "shell 1" }, reply({ shell: odd("shellB"), status: odd("runnin") })),
    ],
    undefined,
    40,
  )
  try {
    const f = await app.until((f) => f.includes("Read shellB"))
    expect(f).not.toMatch(CONTROL)
    expect(f).not.toContain("[31m")
    expect(f).toContain("$ echoing in shellA")
    expect(f).toContain("failed: crashed")
    // A carriage return in a command's output starts a line, as in the shell's own view.
    expect(f).toMatch(/output\s*\n.*next/)
    // A call's input is cleaned as it arrives, its carriage return with the rest; its reply's fields, as drawn.
    expect(f).toContain("⌨ yessir into shell 1 ⏎ · refused: blocked")
    expect(f).toContain("Read shellB · runnin")
  } finally {
    await app.stop()
    office.stop()
  }
})
