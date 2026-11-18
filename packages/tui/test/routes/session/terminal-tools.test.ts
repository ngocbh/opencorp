// An agent's terminal tools in the transcript: which view each takes, and what that view reads from the tool's
// reply, the one JSON object the office returns for every terminal call.
import { expect, test } from "bun:test"
import { toolView } from "../../../src/routes/session"

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

test("toolView maps the five terminal tools, and no plain run, read or close", () => {
  expect(toolView("terminal_run", { command: "ls", why: "look" }, reply()).view).toBe("shell")
  expect(toolView("terminal_type", { shell: "shell 1", text: "yes", why: "answer" }, reply()).view).toBe("typed")
  for (const tool of ["terminal_read", "terminal_interrupt", "terminal_close"]) {
    expect(toolView(tool, { shell: "shell 1" }, reply())).toEqual({
      view: "terminal",
      input: { action: tool.slice("terminal_".length), shell: "shell 1", status: "idle" },
      output: "",
    })
  }
  // Only the terminal group's names: a tool called run, read or close is some other tool.
  for (const tool of ["run", "type", "read", "interrupt", "close"]) {
    expect(toolView(tool, { shell: "shell 1" }, reply())).toEqual({ view: "generic", input: { shell: "shell 1" } })
  }
})

test("a run's view takes its output, exit and shell from the reply", () => {
  const output = "\u001b[31mmissing.o\u001b[0m\nmake: *** [all] Error 2\n"
  // A new shell: the input names none, the reply says which it was.
  expect(
    toolView("terminal_run", { command: "make", why: "build" }, reply({ shell: "shell 2", exit: 2, output })),
  ).toEqual({
    view: "shell",
    input: { command: "make", shell: "shell 2", exit_code: 2, status: "idle" },
    output,
  })
  // A command still running past its wait, and one stopped at a password prompt.
  expect(toolView("terminal_run", { command: "sleep 99", why: "w" }, reply({ status: "running", exit: null })).input)
    .toEqual({ command: "sleep 99", shell: "shell 1", exit_code: null, status: "running" })
  expect(
    toolView(
      "terminal_run",
      { command: "sudo ls", why: "w", shell: "shell 1" },
      reply({ status: "waiting", waiting: "secret", exit: null, output: "[sudo] password for minh: " }),
    ),
  ).toEqual({
    view: "shell",
    input: { command: "sudo ls", shell: "shell 1", exit_code: null, status: "waiting", waiting: "secret" },
    output: "[sudo] password for minh: ",
  })
  // A shell that failed says why.
  expect(
    toolView("terminal_run", { command: "ls", why: "w" }, reply({ status: "failed", exit: null, error: "bash died" }))
      .input.error,
  ).toBe("bash died")
  // A typed line's text, whether it pressed Enter, and its shell.
  expect(toolView("terminal_type", { shell: "shell 1", text: "n", enter: false, why: "w" }, reply())).toEqual({
    view: "typed",
    input: { text: "n", enter: false, shell: "shell 1", status: "idle" },
    output: "",
  })
  expect(toolView("terminal_type", { shell: "shell 1", text: "y", why: "w" }, reply()).input.enter).toBe(true)
})

test("a refused or non-JSON reply falls back", () => {
  // A refusal that names no shell: the shell is the input's, else a new one; the refusal shows, and no output.
  const refused = JSON.stringify({ refused: "shell 3 isn't open" })
  expect(toolView("terminal_run", { command: "ls", why: "w", shell: "shell 3" }, refused)).toEqual({
    view: "shell",
    input: { command: "ls", shell: "shell 3", refused: "shell 3 isn't open" },
    output: "",
  })
  for (const shell of [undefined, "new"]) {
    expect(toolView("terminal_run", { command: "ls", why: "w", shell }, refused).input.shell).toBe("a new shell")
  }
  expect(toolView("terminal_close", { shell: "shell 3" }, refused).input).toEqual({
    action: "close",
    shell: "shell 3",
    refused: "shell 3 isn't open",
  })
  // A call that hasn't replied yet (its output is nothing, or `{}`) takes the terminal view from its input alone.
  for (const output of [undefined, "", "{}"]) {
    expect(toolView("terminal_run", { command: "ls", why: "w" }, output)).toEqual({
      view: "shell",
      input: { command: "ls", shell: "a new shell" },
      output: "",
    })
  }
  // A reply that isn't one JSON object shows as a generic tool, its input as the model gave it.
  for (const output of ["bash: oops", "[1, 2]", '"text"', "null", "{"]) {
    for (const tool of ["terminal_run", "terminal_type", "terminal_read"]) {
      expect(toolView(tool, { shell: "shell 1", text: "y" }, output)).toEqual({
        view: "generic",
        input: { shell: "shell 1", text: "y" },
      })
    }
  }
})
