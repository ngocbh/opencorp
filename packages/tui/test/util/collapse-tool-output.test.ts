// A shell call folded as the upstream TUI's shell view folds it: the command to two rows, the output to its end.
import { expect, test } from "bun:test"
import { collapseShellOutput } from "../../src/util/collapse-tool-output"

const lines = (n: number, name: string) => Array.from({ length: n }, (_, i) => `${name} ${i + 1}`).join("\n")

test("a shell call's command folds to two rows, and its output to its last lines after a count of the rest", () => {
  const folded = collapseShellOutput(`cat <<'EOF'\n${lines(30, "row")}\nEOF`, lines(15, "out"), 10, 1000)
  expect(folded.overflow).toBe(true)
  expect(folded.input).toBe("cat <<'EOF'\nrow 1…")
  // The command takes two of the ten rows and a row parts it from the output, which gets seven: the count, then its
  // last six lines.
  expect(folded.output).toBe(`(9 earlier lines)\n${lines(15, "out").split("\n").slice(-6).join("\n")}`)
})

test("a short command and output stay whole", () => {
  expect(collapseShellOutput("ls", "a\nb", 10, 1000)).toEqual({ input: "ls", output: "a\nb", overflow: false })
  expect(collapseShellOutput("ls", "", 10, 1000)).toEqual({ input: "ls", output: "", overflow: false })
})
