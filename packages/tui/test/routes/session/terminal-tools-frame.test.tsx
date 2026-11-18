// An agent's terminal tools in the transcript: a command as the upstream TUI's shell view (`$ <command>` in its
// shell, its output folded to 10 lines), a typed line as `⌨ <text> into <shell>`, and a read, interrupt or close as
// one line, each read from the tool's JSON reply.
import type { Message, ToolPart } from "@opencorp/protocol"
import type { CapturedLine } from "@opentui/core"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

type App = Awaited<ReturnType<typeof bootFrame>>

const AT = "2026-11-17T10:00:00.000Z"

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

const text = (l: CapturedLine) => l.spans.map((s) => s.text).join("")
/** The foreground of the first span holding `needle` on the first line that has it. */
function fgOf(app: App, needle: string) {
  const line = app.setup.captureSpans().lines.find((l) => text(l).includes(needle))
  return line?.spans.find((s) => s.text.includes(needle))?.fg
}

test("a terminal command shows as $ ls in shell 1 with its output folded", async () => {
  const lines = Array.from({ length: 15 }, (_, i) => `f${String(i + 1).padStart(2, "0")}`)
  lines[0] = `\u001b[1m${lines[0]}\u001b[0m`
  const { office, app } = await boot(
    [
      call("terminal_run", { command: "ls", why: "see the files" }, reply({ output: lines.join("\n") + "\n" })),
      call(
        "terminal_run",
        { command: "make", why: "build", shell: "shell 2" },
        reply({ shell: "shell 2", exit: 2, output: "Error 2\n" }),
      ),
    ],
    undefined,
    50,
  )
  try {
    const f = await app.until((f) => f.includes("$ ls in shell 1") && f.includes("$ make in shell 2"))
    expect(f).toContain("f01")
    expect(f).toContain("f10")
    expect(f).not.toContain("f11")
    expect(f).toContain("Click to expand")
    expect(f).not.toContain("[1m")
    // The exit note is the reply's exit, shown when it isn't 0.
    expect(f).toContain("$ make in shell 2 (exit 2)")
    expect(f).not.toContain("$ ls in shell 1 (exit")
    expect(f).toContain("Error 2")
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

test("a run waiting at a password says so", async () => {
  const { office, app } = await boot([
    call(
      "terminal_run",
      { command: "sudo apt update", why: "refresh the package lists", shell: "shell 1" },
      reply({ status: "waiting", waiting: "secret", exit: null, output: "[sudo] password for minh: ", note: "…" }),
    ),
  ])
  try {
    const f = await app.until((f) => f.includes("waiting for your password"))
    // The spinner takes the `$`, as for any command still running.
    expect(f).toContain("sudo apt update in shell 1")
    expect(f).not.toContain("$ sudo apt update")
    expect(f).toContain("[sudo] password for minh:")
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
