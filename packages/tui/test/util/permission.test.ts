import { expect, test } from "bun:test"
import { APPROVAL_YES, approvalAlwaysOption, approvalSessionOption } from "@opencorp/protocol"
import { shownAction } from "@opencorp/office/util/show"
import {
  permissionAlwaysLines,
  permissionOptions,
  permissionPresentation,
  TARGET_CHARS,
  targetText,
} from "../../src/util/permission"

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

test("a tool card is a tool call whatever its tool's name, its action shown whole", () => {
  for (const tool of ["crm_quote", "shell", "terminal_type"])
    expect(permissionPresentation({ kind: "tool", tool }, `${tool} {"amount":5}`)).toEqual({
      icon: "⚙",
      title: `Call tool ${tool}`,
      lines: [`${tool} {"amount":5}`],
    })
  expect(permissionPresentation({ kind: "tool", tool: "x‮" }, "").title).toBe("Call tool x<U+202E>")
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

test("a card's choices are its own options, matched against the protocol's labels for its rules", () => {
  const rules = ["rm -rf build"]
  const session = approvalSessionOption(rules)
  const always = approvalAlwaysOption(rules)
  expect(session).toBe("Yes, and don't ask again this session for: rm -rf build")
  expect(always).toBe("Yes, and always allow: rm -rf build")
  expect(permissionOptions([APPROVAL_YES, session, always], rules)).toEqual({ yes: "Yes", session, always })
  expect(permissionOptions([APPROVAL_YES], [])).toEqual({ yes: "Yes" })
  // A label for other rules, or one the protocol doesn't name, is never offered.
  expect(permissionOptions([APPROVAL_YES, approvalSessionOption(["make"])], rules)).toEqual({ yes: "Yes" })
  expect(permissionOptions(["Yes", "Yes, and something else"], rules)).toEqual({ yes: "Yes" })
})

test("a card shows what its call acts on, its tool's gate target, as JSON before the call; none without one", () => {
  const target = { run: "r1", call: "r1/agent/3/0" }
  expect(permissionPresentation({ kind: "tool", tool: "flows_approve", target }, 'flows_approve {"id":"x"}')).toEqual({
    icon: "⚙",
    title: "Call tool flows_approve",
    lines: ['flows_approve {"id":"x"}'],
    target: { text: '{"run":"r1","call":"r1/agent/3/0"}', more: 0 },
  })
  for (const none of [null, undefined])
    expect(permissionPresentation({ kind: "tool", tool: "crm_quote", target: none }, "crm_quote {}")).toEqual({
      icon: "⚙",
      title: "Call tool crm_quote",
      lines: ["crm_quote {}"],
    })
  expect(targetText(null)).toBeNull()
  expect(targetText({})).toEqual({ text: "{}", more: 0 })
})

test("a target shows as JSON in printable ASCII: every other character as its \\u escape, which no text can fake", () => {
  const shown = targetText({ cmd: "ls \u001b[2J\u0007\u007f\u0085 \u202e x\ty 😀", pad: "a        b" })!
  expect(shown.text).toBe(
    '{"cmd":"ls \\u001b[2J\\u0007\\u007f\\u0085 \\u202e x\\ty \\ud83d\\ude00","pad":"a        b"}',
  )
  expect(shown.text).toMatch(/^[\x20-\x7e]*$/)
  // It reads back as the target: nothing is lost or made up.
  expect(JSON.parse(shown.text)).toEqual({ cmd: "ls \u001b[2J\u0007\u007f\u0085 \u202e x\ty 😀", pad: "a        b" })
  // Text that looks like an escape shows its backslash doubled, so it reads otherwise than the character's escape.
  const faked = targetText({ a: "\\u202e", b: "\u202e", c: "<U+202E>" })!
  expect(faked.text).toBe('{"a":"\\\\u202e","b":"\\u202e","c":"<U+202E>"}')
})

test("a target too long to show whole shows its head and how much more there is", () => {
  const shown = targetText({ text: "x".repeat(TARGET_CHARS) })!
  expect(shown.text).toHaveLength(TARGET_CHARS)
  expect(shown.text.startsWith('{"text":"xxx')).toBe(true)
  expect(shown.more).toBe('{"text":""}'.length)
  expect(targetText({ text: "x".repeat(TARGET_CHARS - '{"text":""}'.length) })!.more).toBe(0)
})
