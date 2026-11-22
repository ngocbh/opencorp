/** Modes and rules: what runs, what asks the owner, what goes to Auto's check, what is refused, and what a gated
 *  tool returns. */
import { expect, test } from "bun:test"
import { isPending, pending } from "@ngocbh/yian/tools"
import {
  type Action, type ApprovalCard, type CheckInput, decide, type Decision, gate, matches, type Mode, MODES,
  type Permissions, type Rule, RuleBook, suggest, type Verdict, type Where,
} from "../../../src/runtime/permissions/policy.ts"
import { readCommand } from "../../../src/runtime/permissions/commands.ts"

const cmd = (text: string, never?: string): Action => ({ kind: "command", text, ...(never ? { never } : {}) })
const input = (text: string, partial = false): Action => ({ kind: "input", text, ...(partial ? { partial } : {}) })
const rule = (effect: Rule["effect"]) => (pattern: string, kind: Action["kind"] = "command"): Rule =>
  ({ effect, kind, pattern })
const [allow, ask, deny] = [rule("allow"), rule("ask"), rule("deny")]
const W: Where = { profile: "workspace", cwd: "/w", writable: ["/w"] }
const S: Where = { profile: "ssh", cwd: "/home/u", writable: [] }
const DONT = "this session doesn't ask (dontAsk mode): "

/** One row of a mode's table: the action, its rules and where it runs, and the decision. */
type Row = [Action, Rule[], Where, Decision]
/** Checks each row in `mode`; the action's text goes in the comparison so a failure names its row. */
const table = (mode: Mode, rows: Row[]) => {
  for (const [action, rules, where, decision] of rows)
    expect([action.text, decide(action, mode, rules, where)]).toEqual([action.text, decision])
}

/** Permissions that record each card they hold and each check they make; `check` answers as the test says. */
function holding(mode: Mode, o: { book?: RuleBook; where?: Where; check?: (i: CheckInput) => Promise<Verdict> } = {}) {
  const book = o.book ?? new RuleBook()
  const held: { card: ApprovalCard; callId: string }[] = []
  const checked: CheckInput[] = []
  const perms: Permissions = {
    mode: () => mode,
    rules: () => book.list(),
    where: () => o.where ?? W,
    hold: (card, callId) => (held.push({ card, callId }), pending()),
    ...(o.check ? { check: (i: CheckInput) => (checked.push(i), o.check!(i)) } : {}),
  }
  return { perms, held, checked, book }
}
const call = (o: { why?: string; callId?: string; signal?: AbortSignal } = {}) =>
  ({ tool: "shell", why: o.why ?? "", args: {}, callId: "callId" in o ? o.callId : "r/n/1/0",
    signal: o.signal ?? new AbortController().signal })

const READ_ONLY = { verdict: "allow", by: "read-only" } as const
const FILE_OP = { verdict: "allow", by: "a file operation in the workspace" } as const
const BY_RULE = { verdict: "allow", by: "an allow rule" } as const
const ANSWER = { verdict: "allow", by: "a prompt's answer" } as const
const PUSH = { verdict: "allow", by: "a push to a feature branch" } as const
const askMode = (rules: string[]): Decision => ({ verdict: "ask", reason: "Ask mode", rules })

test("the modes are auto, default, ask and dontAsk, in Shift+Tab's order", () => {
  expect(MODES).toEqual(["auto", "default", "ask", "dontAsk"])
})

test("in auto: the rules, then read-only forms, then file operations in the workspace, then Auto's check", () => {
  table("auto", [
    [cmd("squeue -u me | wc -l"), [], S, READ_ONLY],
    [cmd("mkdir -p build && touch build/x"), [], W, FILE_OP],
    [cmd("rm -rf build"), [], W, FILE_OP],
    [cmd("ls && rm -rf build"), [], W, FILE_OP],
    [cmd("rm -rf build"), [], S, { verdict: "check", rules: ["rm -rf build"] }],
    [cmd("rm -rf /tmp/x"), [], W, { verdict: "check", rules: ["rm -rf /tmp/x"] }],
    [cmd("ssh u@n rm x"), [], W, { verdict: "check", rules: ["ssh u@n rm x"] }],
    [cmd("cd /tmp && rm -rf build"), [], W, { verdict: "check", rules: ["cd *", "rm -rf build"] }],
    [cmd("make"), [], W, { verdict: "check", rules: ["make"] }],
    [cmd("htop"), [], W, { verdict: "check", rules: ["htop *"] }],
    [cmd("echo $(id)"), [], W, { verdict: "check", rules: [] }],
    [cmd("make"), [allow("make")], W, BY_RULE],
    [cmd("make && ls"), [allow("make")], W, BY_RULE],
    [input("1"), [], S, ANSWER],
    [input("yes"), [], S, ANSWER],
    [input(""), [], S, ANSWER],
    [input("reboot"), [], S, { verdict: "check", rules: ["reboot"] }],
    [input("ls -l"), [], S, READ_ONLY],
    [input("mkdir x"), [], W, { verdict: "check", rules: ["mkdir x"] }],
    [input("sca", true), [], S, { verdict: "ask", reason: "Auto asks: the line isn't finished", rules: ["sca"] }],
  ])
})

test("in default: the rules, then read-only forms; everything else asks, with no check", () => {
  const rows: Row[] = [
    [cmd("ls -la"), [], W, READ_ONLY],
    [input("1"), [], S, ANSWER],
    [input(""), [], S, ANSWER],
    [cmd("mkdir build"), [], W,
      { verdict: "ask", reason: "Default mode asks before what it doesn't know: mkdir", rules: ["mkdir *"] }],
    [cmd("rm -rf build"), [], W,
      { verdict: "ask", reason: "Default mode asks: it deletes or moves files", rules: ["rm -rf build"] }],
    [cmd("python3 x.py"), [], W,
      { verdict: "ask", reason: "Default mode asks before what it doesn't know: python3", rules: ["python3 x.py"] }],
    [cmd("echo $(id)"), [], W, { verdict: "ask", reason: "Default mode asks: it has a command substitution", rules: [] }],
    [cmd("htop; rm x"), [], W, { verdict: "ask", reason: "Default mode asks: it deletes or moves files", rules: ["htop *", "rm x"] }],
    [cmd("ssh u@n scancel 1"), [], S,
      { verdict: "ask", reason: "Default mode asks: on u@n: it kills or cancels processes or jobs", rules: ["ssh u@n scancel 1"] }],
    [cmd("make"), [], W, { verdict: "ask", reason: "Default mode asks before what it doesn't know: make", rules: ["make"] }],
    [input("sca", true), [], S,
      { verdict: "ask", reason: "Default mode asks before what it doesn't know: sca", rules: ["sca"] }],
    [cmd("ls; ls"), [allow("htop *")], W, READ_ONLY],
  ]
  table("default", rows)
  for (const [, , , decision] of rows) expect(decision.verdict).not.toBe("check")
})

test("in ask: only allow rules; everything else asks, read-only forms included", () => {
  table("ask", [
    [cmd("git status -s"), [], W, askMode(["git status *"])],
    [cmd("git status -s"), [allow("git status *")], W, BY_RULE],
    [cmd("ls"), [], W, askMode(["ls *"])],
    [cmd("ls x; ls y"), [], W, askMode(["ls *"])],
    [cmd("mkdir build"), [], W, askMode(["mkdir *"])],
    [input("1"), [], S, askMode(["1"])],
    [input(""), [], S, askMode([""])],
    [input(""), [allow("", "input")], S, BY_RULE],
    [cmd("echo $(id)"), [], W, askMode([])],
    [input("sca", true), [], S, askMode(["sca"])],
  ])
})

test("in dontAsk: auto's checks, and whatever would ask is refused", () => {
  table("dontAsk", [
    [cmd("ls"), [], W, READ_ONLY],
    [cmd("rm -rf build"), [], W, FILE_OP],
    [input("1"), [], S, ANSWER],
    [cmd("make"), [], W, { verdict: "check", rules: ["make"] }],
    [cmd("echo $(id)"), [], W, { verdict: "check", rules: [] }],
    [input("sca", true), [], S, { verdict: "deny", reason: DONT + "Auto asks: the line isn't finished" }],
    [cmd("git push origin x"), [ask("git push *")], W, { verdict: "deny", reason: DONT + "an ask rule: git push *" }],
    [cmd("cp r reach.sh", "it saves what runs later"), [], W, { verdict: "deny", reason: DONT + "it saves what runs later" }],
  ])
})

test("in every mode a deny rule refuses, nested commands included, and wins over any allow rule", () => {
  const denied: Decision = { verdict: "deny", reason: "a deny rule: rm *" }
  for (const mode of MODES)
    table(mode, [
      [cmd("rm x"), [deny("rm *"), allow("rm x")], W, denied],
      [cmd("echo $(rm x)"), [deny("rm *")], W, denied],
      [cmd("bash -c 'rm x'"), [deny("rm *")], W, denied],
      [cmd("ls; timeout 5 rm x"), [deny("rm *")], W, denied],
      [cmd("FOO=1 rm x"), [deny("rm *")], W, denied],
      [cmd("exec rm x"), [deny("rm *")], W, denied],
      [cmd("ssh h rm x"), [deny("rm *")], W, denied],
      [cmd("ssh a ssh b 'ls; rm x'"), [deny("rm *")], W, denied],
      [cmd("rm x", "it saves what runs later"), [deny("rm *")], W, denied],
      [cmd("rm x > log"), [deny("rm x")], W, { verdict: "deny", reason: "a deny rule: rm x" }],
      [cmd("ls"), [allow("ls *"), deny("ls *")], W, { verdict: "deny", reason: "a deny rule: ls *" }],
    ])
})

test("in every mode an ask rule asks and offers no rule, and dontAsk refuses it", () => {
  for (const mode of MODES) {
    const asked = (pattern: string): Decision => mode === "dontAsk"
      ? { verdict: "deny", reason: `${DONT}an ask rule: ${pattern}` }
      : { verdict: "ask", reason: `an ask rule: ${pattern}`, rules: [] }
    table(mode, [
      [cmd("git push origin feature"), [ask("git push *"), allow("git push origin feature")], W, asked("git push *")],
      [cmd("ls && git push origin x"), [ask("git push *")], W, asked("git push *")],
      [cmd("ls"), [ask("ls *"), allow("ls *")], W, asked("ls *")],
      [cmd("echo $(ls)"), [ask("ls")], W, asked("ls")],
      [cmd("git push"), [ask("git push *"), deny("git *")], W, { verdict: "deny", reason: "a deny rule: git *" }],
    ])
  }
})

test("in every mode a never-automated action asks and no allow rule skips it, and dontAsk refuses it", () => {
  const never = "it saves what runs later"
  for (const mode of MODES) {
    const held: Decision = mode === "dontAsk"
      ? { verdict: "deny", reason: DONT + never }
      : { verdict: "ask", reason: never, rules: [] }
    table(mode, [
      [cmd("cp r reach.sh", never), [], W, held],
      [cmd("cp r reach.sh", never), [allow("cp r reach.sh"), allow("cp *")], W, held],
      [cmd("ls", never), [], W, held],
      [cmd("cp r reach.sh", never), [deny("cp *")], W, { verdict: "deny", reason: "a deny rule: cp *" }],
    ])
  }
})

test("a blocked permissions makes every action ask in every mode and offers no rule, dontAsk refuses it, and a deny rule still refuses first", async () => {
  const why = "rules.yaml doesn't load: line 3: isn't valid YAML"
  const actions = [cmd("ls"), cmd("rm -rf build"), cmd("git push origin feature"), input("y")]
  for (const mode of MODES) {
    const checked: CheckInput[] = []
    const held: ApprovalCard[] = []
    const perms: Permissions = {
      mode: () => mode,
      rules: () => [allow("ls *"), allow("git push *"), deny("make *")],
      where: () => W,
      hold: (card) => (held.push(card), pending()),
      check: async (i) => (checked.push(i), { verdict: "run", reason: "fine" }),
      blocked: () => why,
    }
    for (const action of actions) {
      const gated = await gate(perms, action, call())
      const want: unknown = mode === "dontAsk"
        ? { run: false, result: `Not run: ${DONT}${why}.` }
        : { run: false, reason: why, rules: [] }
      const card = "held" in gated ? gated.held : undefined
      const got: unknown = mode === "dontAsk" ? gated : { run: gated.run, reason: card?.reason, rules: card?.rules }
      expect([action.text, got]).toEqual([action.text, want])
    }
    expect(await gate(perms, cmd("make all"), call())).toEqual({ run: false, result: "Not run: a deny rule: make *." })
    expect(held).toHaveLength(mode === "dontAsk" ? 0 : actions.length)
    expect(checked).toEqual([])
  }
  // Unblocked, the same permissions decide as usual.
  const { perms } = holding("auto")
  expect(await gate({ ...perms, blocked: () => null }, cmd("ls"), call())).toEqual({ run: true, by: "read-only" })
})

test("a pattern that isn't words with one space between each matches nothing, and no card offers one", () => {
  const odd: [string, string[]][] = [
    ["rm  -rf *", ["rm", "", "-rf", "x"]],
    [" rm *", ["", "rm", "x"]],
    ["rm * ", ["rm", "*", ""]],
    ["rm\t*", ["rm\t*"]],
    ["rm *\n", ["rm", "*\n"]],
  ]
  for (const [pattern, words] of odd) expect([pattern, matches(pattern, words)]).toEqual([pattern, false])
  // A typed line's exact rule would hold a tab, which no rule file could keep.
  table("ask", [[input("x='a\tb'"), [], W, askMode([])]])
})

test("in every mode a credential path asks and no allow rule skips it, and dontAsk refuses it", () => {
  const reason = "it names a credential path: ~/.ssh/id_rsa"
  for (const mode of MODES) {
    const held = (why: string): Decision => mode === "dontAsk"
      ? { verdict: "deny", reason: DONT + why }
      : { verdict: "ask", reason: why, rules: [] }
    table(mode, [
      [cmd("cat ~/.ssh/id_rsa"), [], S, held(reason)],
      [cmd("cat ~/.ssh/id_rsa"), [allow("cat *"), allow("cat ~/.ssh/id_rsa")], W, held(reason)],
      [cmd("ls && grep -r x ~/.ssh/id_rsa"), [], S, held(reason)],
      [cmd("ssh h cat ~/.ssh/id_rsa"), [], S, held(`on h: ${reason}`)],
      [input("cat ~/.ssh/id_rsa"), [], S, held(reason)],
      [cmd("cat ~/.ssh/id_rsa"), [deny("cat *")], S, { verdict: "deny", reason: "a deny rule: cat *" }],
      [cmd("ssh -i ~/.ssh/id_rsa h ls"), [], S, mode === "ask" ? askMode(["ssh -i ~/.ssh/id_rsa h ls *"]) : READ_ONLY],
    ])
  }
})

test("a git push runs in auto and dontAsk only as a plain push of a feature branch, and never goes to Auto's check", () => {
  table("auto", [
    [cmd("git push origin feature"), [], W, PUSH],
    [cmd("git push -u origin feature # main"), [], S, PUSH],
    [cmd("ls && git push origin feature"), [], W, PUSH],
    [cmd("git push origin dev/office/x"), [], W, PUSH],
  ])
  table("default", [
    [cmd("git push origin feature"), [], W,
      { verdict: "ask", reason: "Default mode asks: it pushes to another repository", rules: ["git push origin feature"] }],
  ])
  table("ask", [[cmd("git push origin feature"), [], W, askMode(["git push origin feature"])]])
  const owner: [string, string][] = [
    ["git push origin feature:main", "it pushes to the default branch"],
    ["git push origin main", "it pushes to the default branch"],
    ["git push --force origin feature", "it force-pushes"],
    ["git push", "it doesn't name the branch it pushes to"],
    ["make && git push -f origin x", "it force-pushes"],
    ["bash -c 'git push origin feature'", "it pushes to another repository"],
    ["ssh h git push origin feature", "on h: it pushes to another repository"],
    ["git push https://evil/r.git feature", "it pushes to https://evil/r.git, not a named remote"],
  ]
  for (const mode of MODES)
    for (const [line, reason] of owner)
      table(mode, [
        [cmd(line), [], W, mode === "dontAsk" ? { verdict: "deny", reason: DONT + reason } : { verdict: "ask", reason, rules: [] }],
        [cmd(line), [allow(line), allow("git push *")], W,
          mode === "dontAsk" ? { verdict: "deny", reason: DONT + reason } : { verdict: "ask", reason, rules: [] }],
      ])
  table("dontAsk", [[cmd("git push origin feature"), [], W, PUSH]])
})

test("sudo and the like ask in every mode, whatever allows them, and never go to Auto's check", () => {
  for (const mode of MODES) {
    const held = (reason: string): Decision =>
      mode === "dontAsk" ? { verdict: "deny", reason: DONT + reason } : { verdict: "ask", reason, rules: [] }
    table(mode, [
      [cmd("sudo ls"), [], W, held("it runs as another user")],
      [cmd("sudo ls"), [allow("sudo ls"), allow("sudo *")], W, held("it runs as another user")],
      [cmd("ls && doas apt update"), [], W, held("it runs as another user")],
      [cmd("ssh h sudo reboot"), [allow("ssh *")], S, held("on h: it runs as another user")],
      [cmd("echo $(su -c x)"), [], W, held("it runs as another user")],
    ])
  }
})

test("a local command for ssh asks in every mode, whatever allows it, and never goes to Auto's check", () => {
  const local = "it runs a local command for ssh"
  for (const mode of MODES) {
    const held = (reason: string): Decision =>
      mode === "dontAsk" ? { verdict: "deny", reason: DONT + reason } : { verdict: "ask", reason, rules: [] }
    for (const line of [
      "ssh -o ProxyCommand=x h", "ssh -o LocalCommand=x -o PermitLocalCommand=yes h", "ssh -o KnownHostsCommand=x h",
      "ssh -F cfg h", "scp -S x a h:b", "rsync -e 'ssh -i k' a h:b", "rsync --rsh=x a h:b", "GIT_SSH_COMMAND=x git fetch",
      "GIT_SSH=x git fetch", "env GIT_SSH=x git fetch", "git -c core.sshCommand=x fetch",
    ])
      table(mode, [[cmd(line), [allow(line), allow("ssh *"), allow("git *")], S, held(local)]])
    table(mode, [[cmd("ssh h ssh -o ProxyCommand=x g"), [], S, held(`on h: ${local}`)]])
  }
  table("auto", [
    [cmd("ssh -J login u@n squeue -u u"), [], S, READ_ONLY],
    [cmd("ssh -o ProxyJump=j h ls"), [], S, { verdict: "check", rules: ["ssh -o ProxyJump=j h ls *"] }],
  ])
  table("default", [[cmd("ssh -o ProxyJump=j h ls"), [allow("ssh *")], S, BY_RULE]])
})

test("decide refuses a typed line over 1000 bytes before reading it", () => {
  for (const mode of MODES)
    table(mode, [
      [cmd("echo " + "a".repeat(995)), [allow("echo *")], W, BY_RULE],
      [input("x".repeat(1000)), [allow("x".repeat(1000), "input")], S, BY_RULE],
      [input("x".repeat(1001)), [allow("*", "input")], S, { verdict: "deny", reason: "it is longer than 1000 bytes" }],
      [input("é".repeat(501)), [], S, { verdict: "deny", reason: "it is longer than 1000 bytes" }],
    ])
})

test("a command over 1000 bytes asks in every mode, too long to check, and dontAsk refuses it; no rule covers it", async () => {
  const heredoc = cmd(`cat > notes.txt <<'EOF'\n${"a line of notes\n".repeat(200)}EOF`)
  expect(new TextEncoder().encode(heredoc.text).length).toBeGreaterThan(3000)
  // Padding a denied command past the cap must not get it past its deny rule to Auto's check, or to a rule's allow.
  const padded = cmd(`rm -rf build; : ${"x".repeat(1000)}`)
  const rules = [allow("cat *"), allow("cat >notes.txt"), allow("rm -rf build"), allow("*"), deny("rm *")]
  const why = "it is too long to check (over 1000 bytes): read all of it before you say Yes"
  for (const action of [heredoc, padded, cmd(heredoc.text, "it saves what runs later")]) {
    for (const mode of ["auto", "default", "ask"] as const) {
      table(mode, [[action, rules, W, { verdict: "ask", reason: why, rules: [] }]])
    }
    table("dontAsk", [[action, rules, W, { verdict: "deny", reason: DONT + why }]])
    const { perms, held, checked } = holding("auto", { check: async () => ({ verdict: "run", reason: "fine" }) })
    const gated = await gate(perms, action, call())
    expect(!gated.run && isPending(gated.result)).toBe(true)
    expect(checked).toEqual([])
    expect(held.map((h) => [h.card.reason, h.card.rules])).toEqual([[why, []]])
  }
})

/** Permissions in `mode` whose only rule denies `rm *`, with a check that says run and records each call. */
function denying(mode: Mode) {
  const book = new RuleBook()
  book.add(deny("rm *"))
  return holding(mode, { book, check: async () => ({ verdict: "run", reason: "fine" }) })
}

test("with a deny rule in force, a line the reader can't read asks in every mode and dontAsk refuses it; Auto's check never judges it", async () => {
  // A deny rule can't be matched against commands the reader can't see, so a line that may hide one must not reach a
  // check that could say run.
  const lines = [
    "$(printf rm) -rf x", "`printf rm` -rf x", 'sh -c "$CMD"', 'eval "$CMD"', "$X -rf x", "echo 'rm -rf x",
    'echo "rm -rf x', "cat <<EOF\nhi\nEOF", 'bash <<< "$CMD"', 'ssh h "$(printf rm) -rf x"', "echo ${!x}",
    "if true; then $X; fi", "{ $X; }", "echo $((x))", "alias ls=rm", "echo \x01",
  ]
  for (const text of lines) {
    const unreadable = readCommand(text).unreadable
    expect([text, unreadable]).not.toEqual([text, null])
    const why = `deny rules are in force and it can't be read to check them: ${unreadable}`
    for (const mode of ["auto", "default", "ask"] as const)
      table(mode, [[cmd(text), [deny("rm *"), allow("*")], W, { verdict: "ask", reason: why, rules: [] }]])
    table("dontAsk", [[cmd(text), [deny("rm *")], W, { verdict: "deny", reason: DONT + why }]])
    for (const mode of MODES) {
      const { perms, held, checked } = denying(mode)
      const gated = await gate(perms, cmd(text), call())
      expect([text, mode, gated.run, checked]).toEqual([text, mode, false, []])
      expect(held.map((h) => h.card.reason)).toEqual(mode === "dontAsk" ? [] : [why])
      if (mode === "dontAsk") expect(gated).toEqual({ run: false, result: `Not run: ${DONT}${why}.` })
    }
  }
  // What the reader does see in an unreadable line, a deny rule still refuses first.
  for (const mode of MODES)
    table(mode, [
      [cmd('eval "r""m -rf x"'), [deny("rm *")], W, { verdict: "deny", reason: "a deny rule: rm *" }],
      [cmd("echo $(rm -rf x)"), [deny("rm *")], W, { verdict: "deny", reason: "a deny rule: rm *" }],
    ])
  const { perms, checked } = denying("auto")
  expect(await gate(perms, cmd('eval "r""m -rf x"'), call())).toEqual({ run: false, result: "Not run: a deny rule: rm *." })
  expect(checked).toEqual([])
})

test("a typed line the reader can't read asks while an input deny rule is in force; a command deny rule doesn't apply to it", () => {
  const why = "deny rules are in force and it can't be read to check them: it runs text as a command: eval"
  for (const mode of ["auto", "default", "ask"] as const)
    table(mode, [
      [input('eval "$X"'), [deny("rm *", "input")], S, { verdict: "ask", reason: why, rules: [] }],
      [input('eval "$X"', true), [deny("rm *", "input")], S, { verdict: "ask", reason: why, rules: [] }],
    ])
  table("dontAsk", [[input('eval "$X"'), [deny("rm *", "input")], S, { verdict: "deny", reason: DONT + why }]])
  table("auto", [[input('eval "$X"'), [deny("rm *")], S, { verdict: "check", rules: [] }]])
})

test("with no deny rule in force, a line the reader can't read is decided as before", () => {
  for (const rules of [[], [allow("echo *"), ask("make *")], [deny("rm *", "input")]]) {
    table("auto", [
      [cmd("$(printf rm) -rf x"), rules, W, { verdict: "check", rules: [] }],
      [cmd('sh -c "$CMD"'), rules, W, { verdict: "check", rules: [] }],
      [cmd("echo 'x"), rules, W, { verdict: "check", rules: [] }],
    ])
    table("dontAsk", [[cmd('eval "$CMD"'), rules, W, { verdict: "check", rules: [] }]])
    table("default", [[cmd("echo $(id)"), rules, W,
      { verdict: "ask", reason: "Default mode asks: it has a command substitution", rules: [] }]])
    table("ask", [[cmd("echo $(id)"), rules, W, askMode([])]])
  }
})

test("a deny rule refuses what sudo, doas, find -exec, trap, case and a program named by its path run", () => {
  const denied: Decision = { verdict: "deny", reason: "a deny rule: rm *" }
  for (const mode of MODES)
    table(mode, [
      [cmd("/bin/rm x"), [deny("rm *")], W, denied],
      [cmd("sudo rm x"), [deny("rm *")], W, denied],
      [cmd("sudo -u root -E rm x"), [deny("rm *")], W, denied],
      [cmd("doas -u u /bin/rm x"), [deny("rm *")], W, denied],
      [cmd("find . -exec rm {} \\;"), [deny("rm *")], W, denied],
      [cmd("find . -name x -execdir rm {} +"), [deny("rm *")], W, denied],
      [cmd("find . -ok rm {} ; -print"), [deny("rm *")], W, denied],
      [cmd("echo $(( 1 << 2 ))\nrm x"), [deny("rm *")], W, denied],
      [cmd("(( x << 2 ))\nrm x"), [deny("rm *")], W, denied],
      [cmd("case x in (x) rm y;; esac"), [deny("rm *")], W, denied],
      [cmd("trap -- 'rm x' EXIT"), [deny("rm *")], W, denied],
      [cmd("ssh h sudo rm x"), [deny("rm *")], W, denied],
    ])
  table("auto", [[cmd("/tmp/ls -l"), [allow("ls *")], W, { verdict: "check", rules: ["/tmp/ls -l"] }]])
})

test("a glob counts as a credential read only when a literal part names a credential folder or file", () => {
  table("auto", [
    [cmd("grep x *"), [], W, READ_ONLY],
    [cmd("cat src/*"), [], W, READ_ONLY],
    [cmd("wc -l *.ts"), [], W, READ_ONLY],
    [cmd("cat $FILE"), [], W, READ_ONLY],
    [cmd("find . -name x -exec cat {} +"), [], W, { verdict: "check", rules: ["find . -name x -exec cat {} +"] }],
    [cmd("cat ~/.ssh/*"), [], S, { verdict: "ask", reason: "it names a credential path: ~/.ssh/*", rules: [] }],
    [cmd("cat */.aws/*"), [], S, { verdict: "ask", reason: "it names a credential path: */.aws/*", rules: [] }],
  ])
})

test("a recursive read of a folder that holds credentials asks in every mode, and dontAsk refuses it", () => {
  const home: Where = { profile: "ssh", cwd: "/home/u", writable: [] }
  for (const mode of MODES) {
    const held = (why: string): Decision =>
      mode === "dontAsk" ? { verdict: "deny", reason: DONT + why } : { verdict: "ask", reason: why, rules: [] }
    const reads = (path: string) => held(`it reads a folder that holds credentials: ${path}`)
    table(mode, [
      [cmd("grep -r PRIVATE ~"), [], S, reads("~")],
      [cmd("diff -rN ~ /tmp/x"), [], S, reads("~")],
      [cmd("git diff --no-index ~ /dev/null"), [allow("git diff *")], S, reads("~")],
      [cmd("ssh h grep -r PRIVATE ~"), [allow("ssh *")], S, held("on h: it reads a folder that holds credentials: ~")],
      [cmd("ssh h grep -r PRIVATE ."), [], W, held("on h: it reads a folder that holds credentials: .")],
      [cmd("grep -rn x"), [], home, reads(".")],
      [cmd("grep -rn x ../../.."), [], W, reads("../../..")],
      [input("grep -r x ."), [], W, reads(".")],
    ])
  }
  table("auto", [
    [cmd("grep -r x src"), [], W, READ_ONLY],
    [cmd("grep -r x .."), [], { ...W, cwd: "/w/s" }, READ_ONLY],
    [cmd("ls -R ~ && du -sh ~ && find ~ -name x"), [], S, READ_ONLY],
  ])
})

test("a content read through an expansion asks in every mode, and dontAsk refuses it", () => {
  for (const mode of MODES) {
    const held = (why: string): Decision =>
      mode === "dontAsk" ? { verdict: "deny", reason: DONT + why } : { verdict: "ask", reason: why, rules: [] }
    const through = (word: string) => held(`it reads a path named by an expansion: ${word}`)
    table(mode, [
      [cmd("f=~/.ss; cat ${f}h/id_test"), [allow("cat *")], S, through("${f}h/id_test")],
      [cmd("cat $HOME/.ssh/id_rsa"), [], S, held("it names a credential path: $HOME/.ssh/id_rsa")],
      [cmd('cat "$K"'), [allow('cat $K')], S, through("$K")],
      [cmd("d=.ssh; cat ~/$d/id_rsa"), [], S, held("it names a credential path: .ssh")],
      [cmd("d=keys; cat $d/k"), [], S, through("$d/k")],
    ])
  }
  table("auto", [[cmd("ls $HOME"), [], S, READ_ONLY], [cmd("echo $HOME && ls -la $D"), [], S, READ_ONLY]])
  table("default", [[cmd("ls $HOME"), [], S, READ_ONLY]])
})

test("in the workspace sandbox a content read through an expansion follows the usual rules; elsewhere it asks", () => {
  const through = (word: string): Decision => ({ verdict: "ask", reason: `it reads a path named by an expansion: ${word}`, rules: [] })
  table("auto", [
    [cmd('for f in *.md; do head -3 "$f"; done'), [], W, { verdict: "check", rules: [] }],
    [cmd("cat $PWD/x"), [], W, READ_ONLY],
    [cmd('cat "$(git rev-parse --show-toplevel)/x"'), [], W, { verdict: "check", rules: [] }],
    [cmd("grep foo $(git ls-files)"), [], W, { verdict: "check", rules: [] }],
    [cmd("cat $PWD/x"), [], S, through("$PWD/x")],
    [cmd('for f in *.md; do head -3 "$f"; done'), [], S, through("$f")],
    [cmd("ssh h cat $F"), [allow("ssh *")], W,
      { verdict: "ask", reason: "on h: it reads a path named by an expansion: $F", rules: [] }],
    [{ kind: "input", text: "cat $F", into: "ssh u@n" }, [], W, through("$F")],
    [input("cat $F"), [], W, READ_ONLY],
    [cmd('f=~/.ssh/id_rsa; cat "$f"'), [], W, { verdict: "ask", reason: "it names a credential path: ~/.ssh/id_rsa", rules: [] }],
  ])
  table("default", [
    [cmd("cat $PWD/x"), [], W, READ_ONLY],
    [cmd('for f in *.md; do head -3 "$f"; done'), [], W,
      { verdict: "ask", reason: "Default mode asks: it uses a shell keyword: for", rules: [] }],
  ])
  table("dontAsk", [[cmd("cat $PWD/x"), [], S, { verdict: "deny", reason: DONT + "it reads a path named by an expansion: $PWD/x" }]])
})

test("a path the host marks as a credential asks in every mode, like one under ~/.ssh", () => {
  const marked: Where = { ...S, credentials: ["/home/u/keys/id"] }
  for (const mode of MODES) {
    const reason = "it names a credential path: ~/keys/id"
    table(mode, [[cmd("cat ~/keys/id"), [allow("cat *")], marked,
      mode === "dontAsk" ? { verdict: "deny", reason: DONT + reason } : { verdict: "ask", reason, rules: [] }]])
  }
  table("auto", [[cmd("cat ~/keys/id"), [], S, READ_ONLY], [cmd("cat ~/keys/id.pub"), [], marked, READ_ONLY]])
})

test("a content read through an expansion asks wherever the host marks credentials, and in a line typed into ssh or mosh", () => {
  const through = (word: string): Decision => ({ verdict: "ask", reason: `it reads a path named by an expansion: ${word}`, rules: [] })
  const marked: Where = { ...W, credentials: ["/w/keys/id"] }
  table("auto", [
    [cmd("cat $F"), [], marked, through("$F")],
    [cmd("cat $F"), [], W, READ_ONLY],
    [{ kind: "input", text: "cat $F", into: "mosh u@n" }, [], W, through("$F")],
    [{ kind: "input", text: "cat $F", into: "mosh --ssh='ssh -p 2222' -p 60001 u@n -- bash" }, [], W, through("$F")],
    [{ kind: "input", text: "cat $F", into: "cd x && timeout 9 mosh" }, [], W, through("$F")],
    [{ kind: "input", text: "cat $F", into: "cat" }, [], W, READ_ONLY],
  ])
  table("dontAsk", [[cmd("cat $F"), [], marked, { verdict: "deny", reason: DONT + "it reads a path named by an expansion: $F" }]])
})

test("a cd earlier in the line moves the folder later relative reads start from, and one the reader can't follow leaves it unknown", () => {
  const T: Where = { profile: "ssh", cwd: "/tmp/t", writable: [] }
  const unknown: Where = { ...T, cwd: null }
  const asks = (mode: Mode, reason: string): Decision =>
    mode === "dontAsk" ? { verdict: "deny", reason: DONT + reason } : { verdict: "ask", reason, rules: [] }
  const holds = (path: string) => `it reads a folder that holds credentials: ${path}`
  const lost = (path: string) => `it reads a relative path where the folder isn't known: ${path}`
  for (const mode of MODES) {
    table(mode, [
      [cmd("cd ~ && grep -r PRIVATE ."), [], T, asks(mode, holds("."))],
      [cmd("pushd ~ >/dev/null; rg PRIVATE"), [], T, asks(mode, holds("."))],
      [cmd("cd /home; grep -r PRIVATE u"), [], T, asks(mode, holds("u"))],
      [cmd("cd; tar cf - . | ssh h 'cat > x'"), [allow("tar *"), allow("ssh *")], T, asks(mode, holds("."))],
      [cmd("cd ~/.ssh; cat id_rsa"), [], T, asks(mode, "it names a credential path: ~/.ssh")],
      [cmd("cd /etc/ssh && cat ssh_host_ed25519_key"), [], T, asks(mode, "it names a credential path: ssh_host_ed25519_key")],
      [cmd("ssh h 'cd /etc/ssh && cat ssh_host_ed25519_key'"), [allow("ssh *")], T,
        asks(mode, "on h: it names a credential path: ssh_host_ed25519_key")],
      [cmd('cd "$d" && grep -r PRIVATE .'), [], T, asks(mode, lost("."))],
      [cmd("cd /srv; cd - && cat notes"), [], T, asks(mode, lost("notes"))],
      [cmd("cd $(mktemp -d) && head -3 notes"), [allow("cd *"), allow("mktemp *"), allow("head *")], T, asks(mode, lost("notes"))],
      [cmd("grep -r PRIVATE ."), [], unknown, asks(mode, lost("."))],
      [cmd("cat notes"), [allow("cat *")], unknown, asks(mode, lost("notes"))],
    ])
  }
  // A cd is Auto's check's to judge, as it was.
  const checked = { verdict: "check", rules: ["cd *"] } as const
  table("auto", [
    [cmd("cd /srv && grep -r PRIVATE ."), [], T, checked],
    [cmd("cat /etc/hosts && ls"), [], unknown, READ_ONLY],
    [cmd("grep -r PRIVATE /srv"), [], unknown, READ_ONLY],
    // The workspace profile keeps its own rules: the sandbox mounts no home.
    [cmd("cd src && cat x.ts"), [], W, checked],
    [cmd('cd "$d" && grep -r PRIVATE .'), [], W, checked],
    [cmd("cat notes"), [], { ...W, cwd: null }, READ_ONLY],
    // A credential literal still asks everywhere.
    [cmd("cd src && cat ~/.ssh/id_rsa"), [], W, { verdict: "ask", reason: "it names a credential path: ~/.ssh/id_rsa", rules: [] }],
  ])
})

test("a line of many relative cds decides at once, its folder lost, and asks where credentials are reachable", () => {
  const T: Where = { profile: "ssh", cwd: "/tmp/t", writable: [] }
  // Each cd to a new name from each folder so far would double the folders a later part may run in.
  const line = `${Array.from({ length: 100 }, (_, i) => `cd d${i}; `).join("")}grep -r PRIVATE .`
  expect(line.length).toBeLessThan(1000)
  const started = performance.now()
  const decided = decide(cmd(line), "auto", [], T)
  expect(performance.now() - started).toBeLessThan(50)
  expect(decided).toEqual({ verdict: "ask", reason: "it reads a relative path where the folder isn't known: .", rules: [] })
  // A few moves are still followed.
  expect(decide(cmd("cd /; cd home; cd u && grep -r PRIVATE ."), "auto", [], T)).toEqual({
    verdict: "ask", reason: "it reads a folder that holds credentials: .", rules: [],
  })
})

test("the check is told an unknown folder as empty", async () => {
  const where: Where = { profile: "ssh", cwd: null, writable: [] }
  const { perms, checked } = holding("auto", { where, check: async () => ({ verdict: "run", reason: "ok" }) })
  await gate(perms, cmd("make"), call())
  expect(checked).toEqual([{ kind: "command", command: "make", profile: "ssh", cwd: "", host: "" }])
})

test("the check is told the host of a mosh session a line is typed into, as of an ssh one", async () => {
  const { perms, checked } = holding("auto", { check: async () => ({ verdict: "run", reason: "ok" }) })
  await gate(perms, { kind: "input", text: "scancel 42", into: "mosh --ssh 'ssh -J login' u@node" }, call())
  await gate(perms, cmd("mosh -p 60001 u@b -- top"), call())
  expect(checked.map((input) => input.host)).toEqual(["u@node", "u@b"])
})

test("the card offers no rule for what it holds for the owner", () => {
  table("ask", [[cmd("ls && git push origin main"), [], W,
    { verdict: "ask", reason: "it pushes to the default branch", rules: [] }]])
})

test("allow rules let a command run only when they cover every part", () => {
  table("ask", [
    [cmd("htop && top"), [allow("htop *")], W, askMode(["top *"])],
    [cmd("htop && top"), [allow("htop *"), allow("top *")], W, BY_RULE],
    [cmd("htop x"), [allow("htop")], W, askMode(["htop *"])],
    [cmd("timeout 5 htop"), [allow("htop *")], W, BY_RULE],
    [cmd("FOO=1 htop"), [allow("htop *")], W, askMode(["FOO=1 htop"])],
    [cmd("FOO=1 htop"), [allow("FOO=1 htop")], W, BY_RULE],
  ])
})

test("a wildcard allow rule never covers a risky part; an exact one does", () => {
  table("default", [
    [cmd("find / -delete"), [allow("find *")], W,
      { verdict: "ask", reason: "Default mode asks: it deletes or moves files", rules: ["find / -delete"] }],
    [cmd("rm -rf build"), [allow("rm -rf build")], W, BY_RULE],
    [cmd("rm -rf build"), [allow("rm *"), allow("rm -rf build")], W, BY_RULE],
    [cmd("rm -rf src"), [allow("rm -rf build")], W,
      { verdict: "ask", reason: "Default mode asks: it deletes or moves files", rules: ["rm -rf src"] }],
    [cmd("sed -i s/a/b/ f"), [allow("sed *")], W,
      { verdict: "ask", reason: "Default mode asks: it edits files", rules: ["sed -i s/a/b/ f"] }],
    [cmd("ls > out"), [allow("ls *")], W,
      { verdict: "ask", reason: "Default mode asks: it writes or overwrites files", rules: ["ls >out"] }],
    [cmd("ls > out"), [allow("ls >out")], W, BY_RULE],
    [cmd("ls > other"), [allow("ls >out")], W,
      { verdict: "ask", reason: "Default mode asks: it writes or overwrites files", rules: ["ls >other"] }],
  ])
})

test("a hand-written wildcard covers a program that runs code", () => {
  table("default", [
    [cmd("bun test x.test.ts"), [allow("bun test *")], W, BY_RULE],
    [cmd("bun test x.test.ts"), [], W,
      { verdict: "ask", reason: "Default mode asks before what it doesn't know: bun", rules: ["bun test x.test.ts"] }],
  ])
})

test("a host-key option is decided by the mode and rules like any other", () => {
  const line = "ssh -o StrictHostKeyChecking=accept-new h"
  table("ask", [[cmd(line), [], S, askMode([line])]])
  table("default", [
    [cmd(line), [], S, { verdict: "ask", reason: "Default mode asks before what it doesn't know: ssh", rules: [line] }],
    [cmd(line), [allow("ssh *")], S, BY_RULE],
  ])
  table("auto", [[cmd(line), [], S, { verdict: "check", rules: [line] }]])
  for (const mode of ["auto", "default", "dontAsk"] as const) table(mode, [[input("yes"), [], S, ANSWER], [input("no"), [], S, ANSWER]])
  table("ask", [[input("yes"), [], S, askMode(["yes"])]])
})

test("an unreadable line is never covered by an allow rule or a read-only form, and offers no rule", () => {
  table("default", [[cmd("echo $(id)"), [allow("echo *")], W,
    { verdict: "ask", reason: "Default mode asks: it has a command substitution", rules: [] }]])
  table("ask", [[cmd("echo $(id)"), [allow("echo *")], W, askMode([])]])
  table("auto", [
    [cmd("echo $(id)"), [allow("echo *")], W, { verdict: "check", rules: [] }],
    [cmd("ssh u@n 'echo $(id)'"), [allow("ssh *")], W, { verdict: "check", rules: [] }],
  ])
})

test("a suggested rule keeps the program and its subcommand; a risky one or one that runs code is exact", () => {
  const s = (text: string, kind: Action["kind"] = "command") => readCommand(text).parts.map((p) => suggest(p, kind))
  expect(s("git status -s")).toEqual(["git status *"])
  expect(s("ls -la")).toEqual(["ls *"])
  expect(s("ssh u@n squeue -u u")).toEqual(["ssh u@n squeue *"])
  expect(s("ssh -p 22 u@n git log -1")).toEqual(["ssh -p 22 u@n git log *"])
  expect(s("ssh u@n")).toEqual(["ssh u@n"])
  expect(s("ssh -t u@n")).toEqual(["ssh -t u@n"])
  expect(s("ssh u@n 'htop -d 1'")).toEqual(["ssh u@n htop -d 1"])
  expect(s("rm -rf build")).toEqual(["rm -rf build"])
  expect(s("python3 x.py")).toEqual(["python3 x.py"])
  expect(s("make all")).toEqual(["make all"])
  expect(s("timeout 5 htop -d 1")).toEqual(["htop *"])
  expect(s("FOO=1 htop")).toEqual(["FOO=1 htop"])
  expect(s("git -C a status")).toEqual(["git -C a status"])
  expect(s("git")).toEqual(["git"])
  expect(s("htop", "input")).toEqual(["htop"])
  for (const p of ["git", "docker", "kubectl", "systemctl", "module", "conda", "pip", "uv", "opencorp", "scontrol"])
    expect(s(`${p} x -y z`)).toEqual([`${p} x *`])
  for (const p of ["npm", "bun", "cargo"]) expect(s(`${p} x -y z`)).toEqual([`${p} x -y z`])
})

test("a suggested rule that can't match its command is not offered", () => {
  table("default", [
    [cmd("ssh u@n 'htop -d 1'"), [], S, { verdict: "ask", reason: "Default mode asks before what it doesn't know: ssh", rules: [] }],
    [cmd("python3 -c 'print(1); print(2)'"), [], W,
      { verdict: "ask", reason: "Default mode asks before what it doesn't know: python3", rules: [] }],
  ])
})

test("input rules match typed input and command rules don't", () => {
  table("ask", [
    [input("ls"), [allow("ls *")], S, askMode(["ls"])],
    [input("ls"), [allow("ls *", "input")], S, BY_RULE],
    [cmd("ls"), [allow("ls *", "input")], W, askMode(["ls *"])],
  ])
  table("auto", [
    [input("rm x"), [deny("rm *")], S, { verdict: "check", rules: ["rm x"] }],
    [input("rm x"), [deny("rm *", "input")], S, { verdict: "deny", reason: "a deny rule: rm *" }],
    [cmd("rm x"), [deny("rm *", "input")], S, { verdict: "check", rules: ["rm x"] }],
  ])
})

test("a pattern's last * matches any further words, and nothing else is a wildcard", () => {
  expect(matches("ls *", ["ls"])).toBe(true)
  expect(matches("ls *", ["ls", "-l", "x"])).toBe(true)
  expect(matches("ls", ["ls"])).toBe(true)
  expect(matches("ls", ["ls", "-l"])).toBe(false)
  expect(matches("ls *", ["lsx"])).toBe(false)
  expect(matches("l*", ["ls"])).toBe(false)
  expect(matches("ls * x", ["ls", "a", "x"])).toBe(false)
  expect(matches("ls * x", ["ls", "*", "x"])).toBe(true)
  expect(matches("*", ["anything", "at all"])).toBe(true)
  expect(matches("*", [])).toBe(true)
  expect(matches("", [])).toBe(true)
  expect(matches("", ["x"])).toBe(false)
  expect(matches("git status *", ["git"])).toBe(false)
  expect(matches("echo a b", ["echo", "a b"])).toBe(false)
})

test("the gate runs an allowed action, refuses a denied one, and holds one that asks", async () => {
  expect(await gate(holding("auto").perms, cmd("ls"), call())).toEqual({ run: true, by: "read-only" })
  const book = new RuleBook()
  book.add(deny("rm *"))
  const denied = holding("auto", { book })
  expect(await gate(denied.perms, cmd("rm x"), call())).toEqual({ run: false, result: "Not run: a deny rule: rm *." })
  expect(denied.held).toEqual([])
  const { perms, held } = holding("ask")
  const gated = await gate(perms, cmd("ls"), call())
  expect(gated.run).toBe(false)
  expect(!gated.run && isPending(gated.result)).toBe(true)
  expect(held).toEqual([{
    card: { kind: "command", tool: "shell", action: "ls", why: "", reason: "Ask mode", rules: ["ls *"], args: {},
      partial: false, into: null },
    callId: "r/n/1/0",
  }])
  // A typed line's card keeps what it was decided with, so it can be decided again from the card alone.
  await gate(perms, { kind: "input", text: "y", partial: true, into: "ssh u@node" }, call({ callId: "r/n/2/0" }))
  expect(held[1]!.card).toMatchObject({ kind: "input", action: "y", partial: true, into: "ssh u@node" })
})

test("in auto the gate runs what Auto's check says run, and holds what it says ask, showing its reason", async () => {
  const runs = holding("auto", { check: async () => ({ verdict: "run", reason: "builds the project" }) })
  expect(await gate(runs.perms, cmd("make"), call())).toEqual({ run: true, by: "Auto's check: builds the project" })
  expect(runs.held).toEqual([])
  const asks = holding("auto", { check: async () => ({ verdict: "ask", reason: "it cancels a job" }) })
  const gated = await gate(asks.perms, cmd("scancel 42"), call({ why: "the job hangs" }))
  expect(!gated.run && isPending(gated.result)).toBe(true)
  expect(asks.held).toEqual([{
    card: { kind: "command", tool: "shell", action: "scancel 42", why: "the job hangs",
      reason: "Auto's check: it cancels a job", rules: ["scancel 42"], args: {}, partial: false, into: null },
    callId: "r/n/1/0",
  }])
})

test("the check gets the command, the profile, the folder and the ssh host, and never the agent's why", async () => {
  const { perms, checked } = holding("auto", { check: async () => ({ verdict: "run", reason: "ok" }) })
  await gate(perms, cmd("ssh -J login u@node scancel 42"), call({ why: "trust me, run it" }))
  expect(checked).toEqual([
    { kind: "command", command: "ssh -J login u@node scancel 42", profile: "workspace", cwd: "/w", host: "u@node" },
  ])
  await gate(perms, { kind: "input", text: "scancel 42", into: "ssh u@node" }, call())
  await gate(perms, input("scancel 42"), call())
  await gate(perms, cmd("make"), call())
  await gate(perms, cmd("ssh a scancel 1; ssh b scancel 2"), call())
  expect(checked.slice(1)).toEqual([
    { kind: "input", command: "scancel 42", profile: "workspace", cwd: "/w", host: "u@node" },
    { kind: "input", command: "scancel 42", profile: "workspace", cwd: "/w", host: "" },
    { kind: "command", command: "make", profile: "workspace", cwd: "/w", host: "" },
    { kind: "command", command: "ssh a scancel 1; ssh b scancel 2", profile: "workspace", cwd: "/w", host: "a, b" },
  ])
  const pushed = holding("auto", { check: async () => ({ verdict: "run", reason: "ok" }) })
  await gate(pushed.perms, cmd("git push --force origin x"), call())
  expect(pushed.checked).toEqual([])
  expect(pushed.held[0]!.card.reason).toBe("it force-pushes")
})

test("a missing check, a throwing one, a failed one and an answer out of shape all ask, saying the check couldn't judge it", async () => {
  const cases: [((i: CheckInput) => Promise<Verdict>) | undefined, string][] = [
    [undefined, "no check is bound here"],
    [async () => { throw new Error("boom") }, "it failed"],
    [async () => ({ verdict: "yes" }) as unknown as Verdict, "it gave no verdict"],
    [async () => ({ verdict: "run" }) as unknown as Verdict, "it gave no verdict"],
    [async () => null as unknown as Verdict, "it gave no verdict"],
    [async () => ({ verdict: "ask", reason: "it timed out", failed: true }), "it timed out"],
    [async () => ({ verdict: "run", reason: "it timed out", failed: true }), "it timed out"],
  ]
  for (const [check, why] of cases) {
    const { perms, held } = holding("auto", check ? { check } : {})
    const gated = await gate(perms, cmd("make"), call())
    expect(gated.run).toBe(false)
    expect(held.map((h) => h.card.reason)).toEqual([`Auto asks: its check couldn't judge this: ${why}`])
  }
})

test("the check's reason shows as one line of at most 200 characters", async () => {
  const { perms, held } = holding("auto", {
    check: async () => ({ verdict: "ask", reason: "a\nb\x1b[2Jc" + "x".repeat(300) }),
  })
  await gate(perms, cmd("make"), call())
  const shown = held[0]!.card.reason.slice("Auto's check: ".length)
  expect(shown).toBe("a b [2Jc" + "x".repeat(191) + "…")
  expect(shown.length).toBe(200)
  const spaced = holding("auto", { check: async () => ({ verdict: "run", reason: "  a \t\r\n  b \u2028 " }) })
  expect(await gate(spaced.perms, cmd("make"), call())).toEqual({ run: true, by: "Auto's check: a b" })
})

test("in dontAsk what would ask is refused, and no card is held", async () => {
  const asks = holding("dontAsk", { check: async () => ({ verdict: "ask", reason: "it cancels a job" }) })
  expect(await gate(asks.perms, cmd("scancel 42"), call())).toEqual({
    run: false, result: "Not run: this session doesn't ask (dontAsk mode): Auto's check: it cancels a job.",
  })
  const failed = holding("dontAsk", { check: async () => ({ verdict: "ask", reason: "it timed out", failed: true }) })
  expect(await gate(failed.perms, cmd("scancel 42"), call())).toEqual({
    run: false,
    result: "Not run: this session doesn't ask (dontAsk mode): Auto asks: its check couldn't judge this: it timed out.",
  })
  const runs = holding("dontAsk", { check: async () => ({ verdict: "run", reason: "builds" }) })
  expect(await gate(runs.perms, cmd("make"), call())).toEqual({ run: true, by: "Auto's check: builds" })
  const pushed = holding("dontAsk")
  expect(await gate(pushed.perms, cmd("git push origin main"), call())).toEqual({
    run: false, result: "Not run: this session doesn't ask (dontAsk mode): it pushes to the default branch.",
  })
  expect([...asks.held, ...failed.held, ...runs.held, ...pushed.held]).toEqual([])
})

test("a call stopped while its check runs runs nothing and holds nothing", async () => {
  const stop = new AbortController()
  const { perms, held } = holding("auto", {
    check: () => new Promise((_, reject) => stop.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  })
  const gated = gate(perms, cmd("make"), call({ signal: stop.signal }))
  stop.abort()
  expect(await gated).toEqual({ run: false, result: "Not run: stopped before Auto's check finished." })
  const late = holding("auto", { check: async () => (stop.signal.aborted, { verdict: "run", reason: "ok" }) })
  expect(await gate(late.perms, cmd("make"), call({ signal: stop.signal }))).toEqual({
    run: false, result: "Not run: stopped before Auto's check finished.",
  })
  expect([...held, ...late.held]).toEqual([])
})

test("a switch to dontAsk while Auto's check runs refuses the call rather than hold a card nobody answers", async () => {
  let mode: Mode = "auto"
  const held: ApprovalCard[] = []
  const perms: Permissions = {
    mode: () => mode,
    rules: () => [],
    where: () => W,
    hold: (card) => (held.push(card), pending()),
    check: async () => {
      mode = "dontAsk"
      return { verdict: "ask", reason: "it cancels a job" }
    },
  }
  expect(await gate(perms, cmd("scancel 42"), call())).toEqual({
    run: false, result: "Not run: this session doesn't ask (dontAsk mode): Auto's check: it cancels a job.",
  })
  expect(held).toEqual([])
})

test("a call with no call id can't wait for the owner", async () => {
  const { perms, held } = holding("ask")
  expect(await gate(perms, cmd("ls"), call({ callId: undefined }))).toEqual({
    run: false, result: "Not run: this call can't wait for the owner's approval.",
  })
  expect(held).toEqual([])
  expect(await gate(holding("ask").perms, cmd("rm x"), call({ callId: undefined }))).toEqual({
    run: false, result: "Not run: this call can't wait for the owner's approval.",
  })
})

test("the session's rule book adds a rule once and removes it", async () => {
  const book = new RuleBook()
  book.add(allow("ls *"))
  book.add({ ...allow("ls *") })
  book.add(allow("ls *", "input"))
  expect(book.list()).toEqual([allow("ls *"), allow("ls *", "input")])
  expect(book.remove(allow("ls *", "input"))).toBe(true)
  expect(book.remove(allow("ls *", "input"))).toBe(false)
  expect(book.list()).toEqual([allow("ls *")])
  const listed = book.list() as Rule[]
  listed.push(deny("ls *"))
  expect(book.list()).toEqual([allow("ls *")])
  const { perms } = holding("ask", { book })
  expect(await gate(perms, cmd("ls -l"), call())).toEqual({ run: true, by: "an allow rule" })
  book.remove(allow("ls *"))
  expect((await gate(perms, cmd("ls -l"), call())).run).toBe(false)
})
