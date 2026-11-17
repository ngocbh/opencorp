import { expect, test } from "bun:test"
import { shownAction } from "@opencorp/office/util/show"
import { permissionAlwaysLines, permissionOptions, permissionPresentation } from "../../src/util/permission"

test("each tool's approval has its title and body: a shell command, a typed line, and any other tool", () => {
  for (const tool of ["shell", "workspace_shell", "terminal_run"])
    expect(permissionPresentation({ tool }, "rm -rf build")).toEqual({
      icon: "#",
      title: "Shell command",
      lines: ["$ rm -rf build"],
    })
  expect(
    permissionPresentation({ tool: "terminal_type", args: { shell: "misha" }, into: "ssh nhb25@misha" }, "yes"),
  ).toEqual({ icon: "⌨", title: "Type into misha", lines: ["yes", "Into: ssh nhb25@misha"] })
  // Typed without Enter, into a shell the card doesn't name; odd characters in what the card names are escaped.
  expect(permissionPresentation({ tool: "terminal_type", partial: true, into: "ssh h‮" }, "1")).toEqual({
    icon: "⌨",
    title: "Type into a running command",
    lines: ["1", "(without Enter)", "Into: ssh h<U+202E>"],
  })
  // Enter alone types nothing, and says so.
  expect(permissionPresentation({ tool: "terminal_type", args: { shell: "s1" } }, "").lines).toEqual(["(Enter alone)"])
  expect(permissionPresentation({ tool: "deploy", args: { env: "prod" } }, "deploy --prod")).toEqual({
    icon: "⚙",
    title: "Call tool deploy",
    lines: ["deploy --prod"],
  })
})

test("a command of several lines shows numbered, as the office shows it", () => {
  const shown = shownAction("cd build\nmake ‮all")
  expect(shown).toBe("  1  cd build\n  2  make <U+202E>all")
  expect(permissionPresentation({ tool: "shell" }, shown).lines).toEqual(["$   1  cd build", "    2  make <U+202E>all"])
})

test("the always pages name what they save, and each rule whole, its odd characters escaped", () => {
  expect(permissionAlwaysLines("session", ["rm -rf build", "make ‮clean"], "minh")).toEqual([
    "These will run without asking for the rest of this session:",
    "- rm -rf build",
    "- make <U+202E>clean",
  ])
  expect(permissionAlwaysLines("always", ["git push origin feature"], "minh")).toEqual([
    "These will always run for @minh without asking (people/minh/rules.yaml):",
    "- git push origin feature",
  ])
})

test("a card's choices are read from its own options, each sent as the office wrote it", () => {
  const session = "Yes, and don't ask again this session for: rm -rf build"
  const always = "Yes, and always allow: rm -rf build"
  expect(permissionOptions(["Yes", session, always])).toEqual({ yes: "Yes", session, always })
  expect(permissionOptions(["Yes"])).toEqual({ yes: "Yes" })
  // A label the TUI doesn't know is never offered.
  expect(permissionOptions(["Yes", "Yes, and something else"])).toEqual({ yes: "Yes" })
})
