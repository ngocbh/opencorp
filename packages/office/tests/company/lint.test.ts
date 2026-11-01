/** Checking a loaded company repo (Python's `tests/company/test_lint.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { writeYaml } from "../../src/company/flow_yaml.ts"
import { MAX_FLOW_FILE } from "../../src/company/flows.ts"
import { lint } from "../../src/company/lint.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { assetToolName } from "../../src/company/naming.ts"
import { writeCompany } from "../../src/company_template/index.ts"
import { tempDir } from "../helpers.ts"
import { baseFiles, CHAT, CHILD, company, MAIN, makeCompany, parentFlow, person } from "./helpers.ts"

setDefaultTimeout(30_000)

/** Each lint finding of `severity` in the repo at `root`, as `code path`. */
async function issues(root: string, severity = "error"): Promise<Set<string>> {
  const found = (await lint(loadRepo(root))).filter((issue) => issue.severity === severity)
  return new Set(found.map((issue) => `${issue.code} ${issue.path}`))
}

/** The codes of the lint findings of `severity` in the repo at `root`. */
async function codes(root: string, severity = "error"): Promise<Set<string>> {
  const found = (await lint(loadRepo(root))).filter((issue) => issue.severity === severity)
  return new Set(found.map((issue) => issue.code))
}

/** The lint findings with `code` in the repo at `root`. */
async function withCode(root: string, code: string) {
  return (await lint(loadRepo(root))).filter((issue) => issue.code === code)
}

test("clean repo has no issues", async () => {
  expect(await lint(loadRepo(company()))).toEqual([])
})

test("unknown manager", async () => {
  const root = makeCompany({ "people/minh/person.yaml": person("minh", { manager: "ghost" }) })
  expect(await issues(root)).toContain("person.unknown_manager people/minh/person.yaml")
})

test("manager cycle is reported once", async () => {
  const root = makeCompany({ "people/ngocbh/person.yaml": person("ngocbh", { manager: "minh" }) })
  const found = await withCode(root, "person.manager_cycle")
  expect(found.map((issue) => issue.message)).toEqual(["minh -> ngocbh"])
})

test("ceo has manager", async () => {
  const company = { ...(baseFiles()["company.yaml"] as object), ceo: "minh" }
  expect(await codes(makeCompany({ "company.yaml": company }))).toContain("company.ceo_has_manager")
})

test("an agent ceo is an error", async () => {
  const company = { ...(baseFiles()["company.yaml"] as object), ceo: "minh" }
  const root = makeCompany({ "company.yaml": company, "people/minh/person.yaml": person("minh", { manager: null }) })
  const found = await issues(root)
  expect(found).toContain("company.ceo_not_human company.yaml")
  expect(found).not.toContain("company.ceo_has_manager company.yaml")
})

test("unknown ceo", async () => {
  const company = { ...(baseFiles()["company.yaml"] as object), ceo: "ghost" }
  expect(await codes(makeCompany({ "company.yaml": company }))).toContain("company.unknown_ceo")
})

test("missing company yaml does not crash lint", async () => {
  expect(await codes(makeCompany({ "company.yaml": null }))).toContain("repo.unreadable")
})

test("ids that differ only by case", async () => {
  // A ULID and its lowercase spelling are both valid ids. Built in memory: their
  // files can't both exist on a case-insensitive disk.
  const upper = "01J8Z3NDEKTSV4RRFFQ69G5FAV"
  const lower = upper.toLowerCase()
  const repo = loadRepo(company())
  const twins = [upper, lower].map((id) => [id, { ...repo.groups.get("eng")!, id }] as const)
  const found = (await lint({ ...repo, groups: new Map([...repo.groups, ...twins]) }))
    .filter((issue) => issue.code === "repo.id_case_clash")
  expect(found.map((issue) => [issue.path, issue.message])).toEqual([
    [`groups/${lower}.yaml`, `${upper} and ${lower} differ only by case`],
  ])
})

test("unknown group parent and head", async () => {
  const group = { id: "eng", name: "Engineering", parent: "nope", head: "ghost" }
  const found = await codes(makeCompany({ "groups/eng.yaml": group }))
  expect(found).toContain("group.unknown_parent")
  expect(found).toContain("group.unknown_head")
})

test("group parent cycle", async () => {
  const root = makeCompany({
    "groups/eng.yaml": { id: "eng", name: "Engineering", parent: "infra", head: null },
    "groups/infra.yaml": { id: "infra", name: "Infra", parent: "eng", head: "minh" },
  })
  const found = await withCode(root, "group.parent_cycle")
  expect(found.map((issue) => issue.message)).toEqual(["eng -> infra"])
})

test("person in unknown group", async () => {
  const root = makeCompany({ "people/minh/person.yaml": person("minh", { groups: ["eng", "nope"] }) })
  expect(await issues(root)).toContain("person.unknown_group people/minh/person.yaml")
})

/** The base asset file with `changes` applied. */
function asset(changes: Record<string, unknown>): Record<string, unknown> {
  return { ...(baseFiles()["assets/fake.yaml"] as object), ...changes }
}

test("asset tool name matches design", () => {
  expect(assetToolName("cluster-a", "submit_job")).toBe("cluster_a__submit_job")
})

test("unknown grantees", async () => {
  const grants = [{ who: "group:nope", can: ["echo"] }, { who: "ghost", can: ["echo"] }]
  const root = makeCompany({ "assets/fake.yaml": asset({ grants }) })
  const found = await withCode(root, "asset.unknown_grantee")
  expect(found.map((issue) => issue.message).sort()).toEqual(["ghost", "group:nope"])
})

test("person grantee is known", async () => {
  const grants = [{ who: "minh", can: ["admin"] }]
  expect(await codes(makeCompany({ "assets/fake.yaml": asset({ grants }) }))).toEqual(new Set())
})

test("unknown tool in grant", async () => {
  const grants = [{ who: "group:eng", can: ["echo", "nope"] }]
  expect(await codes(makeCompany({ "assets/fake.yaml": asset({ grants }) }))).toContain("asset.unknown_tool")
})

test("tool name too long", async () => {
  const long = "t".repeat(70)
  const fake = asset({ tools: { [long]: {} }, grants: [{ who: "group:eng", can: [long] }] })
  expect(await codes(makeCompany({ "assets/fake.yaml": fake }))).toContain("asset.tool_name_invalid")
})

test("gated tool granted directly is a warning", async () => {
  const root = makeCompany({ "assets/fake.yaml": asset({ tools: { echo: { risk: "gated" } } }) })
  expect(await codes(root)).toEqual(new Set())
  expect(await codes(root, "warning")).toContain("asset.gated_tool_granted")
})

test("missing flow", async () => {
  const minh = person("minh", { main: "../../shared/flows/nope.yaml" })
  const root = makeCompany({ "people/minh/person.yaml": minh })
  expect(await codes(root)).toContain("person.flow_missing")
})

test("invalid flow carries composer message", async () => {
  const root = makeCompany({ "shared/flows/chat.yaml": "id: chat\nname: chat\noutputs: 1\n" })
  const [issue, ...rest] = await withCode(root, "person.flow_invalid")
  expect(rest).toEqual([])
  expect(issue!.message).toContain("output")
  expect(issue!.message).not.toContain("LoadError")
})

test("unexpected flow error names its type", async () => {
  // A flow that isn't UTF-8 fails in the decoder, outside yian's LoadError.
  const root = makeCompany({ "shared/flows/chat.yaml": new Uint8Array([0xff, 0xfe, 0x0a]) })
  const [issue, ...rest] = await withCode(root, "person.flow_invalid")
  expect(rest).toEqual([])
  expect(issue!.message).toStartWith("../../shared/flows/chat.yaml: TypeError: ")
})

test("flow outside repo", async () => {
  const tmp = tempDir()
  const minh = person("minh", { main: "../../../etc/passwd" })
  const root = makeCompany({ "people/minh/person.yaml": minh }, tmp)
  const [issue, ...rest] = await withCode(root, "person.flow_outside_repo")
  expect(rest).toEqual([])
  expect(issue!.message).not.toContain(tmp)
  expect(issue!.message).toContain("../etc/passwd")
})

test("flow cycle message is repo relative", async () => {
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("chat") })
  const [issue, ...rest] = await withCode(root, "person.flow_invalid")
  expect(rest).toEqual([])
  expect(issue!.message).not.toContain(root)
  expect(issue!.message).toContain("shared/flows/chat.yaml")
})

test("a child flow over the size limit is invalid, named repo relative and without its content", async () => {
  const tmp = tempDir()
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("echo") }, tmp)
  // Written after the commit: lint reads the working tree.
  fs.writeFileSync(path.join(root, "shared/flows/echo.yaml"), CHILD + "#PADPAD\n".repeat(MAX_FLOW_FILE / 8 + 1))
  const [issue, ...rest] = await withCode(root, "person.flow_invalid")
  expect(rest).toEqual([])
  expect(issue!.message).toContain("shared/flows/echo.yaml is over the 1 MiB flow size limit")
  expect(issue!.message).not.toContain(tmp)
  expect(issue!.message).not.toContain("PADPAD")
})

test("child flow inside repo is fine", async () => {
  // A main flow must be chat-shaped, so the parent that imports the child is a SOP.
  const root = makeCompany({
    "people/minh/person.yaml": person("minh", { sops: [{ flow: "../../shared/flows/parent.yaml" }] }),
    "shared/flows/parent.yaml": parentFlow("echo"),
    "shared/flows/echo.yaml": CHILD,
  })
  expect(await codes(root)).toEqual(new Set())
})

test("child flow outside repo", async () => {
  const tmp = tempDir()
  fs.writeFileSync(path.join(tmp, "echo.yaml"), CHILD) // tmp/company is the repo
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("../../../echo") }, tmp)
  const [issue, ...rest] = await withCode(root, "person.flow_outside_repo")
  expect(rest).toEqual([])
  expect(issue!.message).not.toContain(tmp)
  expect(issue!.message).toContain("../echo.yaml")
})

test("repo reached through a symlink", async () => {
  const tmp = tempDir()
  const link = path.join(tmp, "link")
  fs.symlinkSync(company(tmp), link)
  expect(await lint(loadRepo(link))).toEqual([])
})

test("sop flows are checked", async () => {
  const sops = [{ flow: "../../shared/flows/nope.yaml" }]
  expect(await codes(makeCompany({ "people/minh/person.yaml": person("minh", { sops }) })))
    .toContain("person.flow_missing")
})

test("routine flows are checked", async () => {
  const routines = [{ name: "daily", flow: "../../shared/flows/nope.yaml" }]
  const root = makeCompany({ "people/minh/person.yaml": person("minh", { routines }) })
  expect(await codes(root)).toContain("person.flow_missing")
})

test.each(["main", "sops", "routines"])("nul byte in a flow ref is invalid [%s]", async (field) => {
  const ref = "../../shared/flows/chat\0.yaml"
  const value = { main: ref, sops: [{ flow: ref }], routines: [{ name: "daily", flow: ref }] }[field]
  const root = makeCompany({ "people/minh/person.yaml": person("minh", { [field]: value }) })
  const [issue, ...rest] = await withCode(root, "person.flow_invalid")
  expect(rest).toEqual([])
  expect(issue!.path).toBe("people/minh/person.yaml")
  expect(issue!.message).not.toContain("\0")
})

test.each(["main", "sops", "routines"])("absolute flow ref is invalid [%s]", async (field) => {
  // A flow inside the repo that exists; the worker would look for it under the session's pinned worktree.
  const dir = tempDir()
  const ref = path.join(fs.realpathSync(dir), "company/shared/flows/chat.yaml")
  const value = { main: ref, sops: [{ flow: ref }], routines: [{ name: "daily", flow: ref }] }[field]
  const root = makeCompany({ "people/minh/person.yaml": person("minh", { [field]: value }) }, dir)
  expect(fs.existsSync(ref)).toBe(true)
  const [issue, ...rest] = await withCode(root, "person.flow_invalid")
  expect(rest).toEqual([])
  expect(issue!.path).toBe("people/minh/person.yaml")
  expect(issue!.message).toContain("chat.yaml")
  expect(issue!.message).toContain("relative to people/minh/")
  expect(issue!.message).not.toContain(dir)
  expect(issue!.message).not.toContain(fs.realpathSync(dir))
})

test.each(["main", "sops", "routines"])("absolute flow ref outside the repo is flow_outside_repo [%s]", async (field) => {
  const ref = "/etc/passwd"
  const value = { main: ref, sops: [{ flow: ref }], routines: [{ name: "daily", flow: ref }] }[field]
  const root = makeCompany({ "people/minh/person.yaml": person("minh", { [field]: value }) })
  const [issue, ...rest] = await withCode(root, "person.flow_outside_repo")
  expect(rest).toEqual([])
  expect(issue!.path).toBe("people/minh/person.yaml")
  expect(await codes(root)).not.toContain("person.flow_invalid")
})

test("a missing child flow is invalid, named repo relative", async () => {
  const tmp = tempDir()
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("echo") }, tmp)
  const [issue, ...rest] = await withCode(root, "person.flow_invalid")
  expect(rest).toEqual([])
  expect(issue!.message).toContain("shared/flows/echo.yaml does not exist")
  expect(issue!.message).not.toContain(tmp)
  expect(issue!.message).not.toContain(fs.realpathSync(tmp))
  expect(issue!.message).not.toContain("ENOENT")
})

test("agent needs a main flow", async () => {
  const minh = person("minh")
  delete minh["main"]
  expect(await issues(makeCompany({ "people/minh/person.yaml": minh }))).toContain(
    "person.no_main people/minh/person.yaml",
  )
})

test("a main flow must declare person and talking_to", async () => {
  const root = makeCompany({ "shared/flows/chat.yaml": CHAT })
  const [issue, ...rest] = await withCode(root, "person.main_inputs_missing")
  expect(rest).toEqual([])
  expect([issue!.path, issue!.severity]).toEqual(["people/minh/person.yaml", "error"])
  expect(issue!.message).toBe(
    "../../shared/flows/chat.yaml doesn't declare the messages, person, talking_to, summary, history, turns"
      + " and max_turns inputs; the office passes them to a main flow and Yian refuses inputs a flow doesn't"
      + " declare, so declare them under input: as the template's shared/flows/chat.yaml does",
  )
})

test("a main flow missing one input names only that one", async () => {
  const flow = MAIN.replace("  talking_to: !str\n", "")
  const root = makeCompany({ "shared/flows/chat.yaml": flow })
  const [issue] = await withCode(root, "person.main_inputs_missing")
  expect(issue!.message).toStartWith("../../shared/flows/chat.yaml doesn't declare the talking_to input;")
})

test("only the main flow needs the office inputs", async () => {
  const sops = [{ flow: "../../shared/flows/plain.yaml" }]
  const routines = [{ name: "daily", flow: "../../shared/flows/plain.yaml" }]
  const root = makeCompany({
    "shared/flows/plain.yaml": CHAT.replace("id: chat\nname: chat", "id: p\nname: p"),
    "people/minh/person.yaml": person("minh", { sops, routines }),
  })
  expect(await codes(root)).toEqual(new Set())
})

test("the template flows pass lint", async () => {
  const dir = tempDir()
  const root = path.join(dir, "company")
  await writeCompany(root, path.join(dir, "worktrees"), { company: "Acme", owner: { handle: "ngocbh", name: "Ngoc" } })
  const agent = {
    handle: "minh", name: "Minh", kind: "agent", title: "Engineer", manager: "ngocbh",
    main: "../../shared/flows/chat.yaml", harnesses: ["composer"],
  }
  fs.mkdirSync(path.join(root, "people/minh"))
  fs.writeFileSync(path.join(root, "people/minh/person.yaml"), writeYaml(agent))
  fs.writeFileSync(path.join(root, "people/minh/profile.md"), "# Minh, Engineer\n")
  expect(await lint(loadRepo(root))).toEqual([])
})

/** The single `person.main_chat_shape` finding when minh's main flow is `flow`. */
async function chatShapeIssue(flow: string) {
  const root = makeCompany({ "shared/flows/chat.yaml": flow })
  expect(await codes(root)).toEqual(new Set(["person.main_chat_shape"]))
  const [issue, ...rest] = await withCode(root, "person.main_chat_shape")
  expect(rest).toEqual([])
  expect([issue!.path, issue!.severity]).toEqual(["people/minh/person.yaml", "error"])
  expect(issue!.message).toStartWith("../../shared/flows/chat.yaml")
  expect(issue!.message).toContain("as the template's shared/flows/chat.yaml does")
  return issue!
}

test("a main flow whose messages input is not an inbox of messages is a lint error", async () => {
  // The turn takes the same inbox, and a prompt can't splice strings as messages.
  const flow = MAIN.replaceAll("messages: !Inbox(Message)", "messages: !Inbox(str)")
    .replace("        prompt:\n          - ${said}\n", "        prompt: \"${said}\"\n")
  expect((await chatShapeIssue(flow)).message).toContain("messages: !Inbox(Message)")
})

test("a main flow whose reply does not steer from the messages inbox is a lint error", async () => {
  const spaced = MAIN.replaceAll("${input.messages}", "${ input.messages }")
  expect(await codes(makeCompany({ "shared/flows/chat.yaml": spaced }))).toEqual(new Set())
  const unsteered = MAIN.replace("        steer_inbox: ${input.messages}\n", "")
  expect((await chatShapeIssue(unsteered)).message).toContain("steer_inbox: ${input.messages}")
  // A second inbox, declared and carried into the turn beside messages, that the reply steers from instead.
  const other = MAIN.replace(/^( +)messages: (.+)$/gm,
    (line, indent: string, value: string) => `${line}\n${indent}other: ${value.replace("messages", "other")}`)
    .replace("steer_inbox: ${input.messages}", "steer_inbox: ${input.other}")
  expect(other).toContain("steer_inbox: ${input.other}")
  expect((await chatShapeIssue(other)).message).toContain("steer_inbox: ${input.messages}")
})

test("a main flow whose reply output is not optional is a lint error", async () => {
  const message = (await chatShapeIssue(MAIN.replace("output: Optional(str)", "output: str"))).message
  expect(message).toContain("interrupt")
  expect(message).toContain("Optional(")
})

/** A flow `id` whose one CODE node calls `fn` in the file `file` with its `text` input. */
function codeFlow(id: string, file: string): string {
  return `id: ${id}\nname: ${id}\ninput:\n  text: !str\nnodes:\n`
    + `  a: {kind: code, code: ${file}:fn, input: {x: "\${input.text}"}}\noutput: \${a.output}\n`
}

/** Writes a module outside the repo in `tmp` that a CODE node could name; loading never imports it. */
function outsideModule(tmp: string): string {
  const file = path.join(tmp, "outside.ts")
  fs.writeFileSync(file, "export function fn(input: { x: string }) { return input.x }\n")
  return file
}

/** Checks the repo at `root` has a single `person.flow_invalid` finding, naming the code root. */
async function codeRootIssue(root: string) {
  const [issue, ...rest] = await withCode(root, "person.flow_invalid")
  expect(rest).toEqual([])
  expect(issue!.path).toBe("people/minh/person.yaml")
  expect(issue!.message).toContain("outside the code root")
}

test("a code reference outside the repo is a lint error", async () => {
  const tmp = tempDir()
  outsideModule(tmp)
  await codeRootIssue(makeCompany({ "shared/flows/chat.yaml": codeFlow("chat", "../../../outside.ts") }, tmp))
})

test("a code reference outside the repo in a child flow is a lint error", async () => {
  const tmp = tempDir()
  outsideModule(tmp)
  const root = makeCompany({
    "shared/flows/chat.yaml": parentFlow("echo"),
    "shared/flows/echo.yaml": codeFlow("echo", "../../../outside.ts"),
  }, tmp)
  await codeRootIssue(root)
})

test("a symlinked code file pointing out of the repo is a lint error", async () => {
  const tmp = tempDir()
  const root = makeCompany({ "shared/flows/chat.yaml": codeFlow("chat", "./link.ts") }, tmp)
  fs.symlinkSync(outsideModule(tmp), path.join(root, "shared/flows/link.ts"))
  await codeRootIssue(root)
})

test("a child flow symlinked out of the repo is outside the repo", async () => {
  const tmp = tempDir()
  fs.writeFileSync(path.join(tmp, "echo.yaml"), CHILD)
  const root = makeCompany({ "shared/flows/chat.yaml": parentFlow("echo") }, tmp)
  fs.symlinkSync(path.join(tmp, "echo.yaml"), path.join(root, "shared/flows/echo.yaml"))
  const [issue, ...rest] = await withCode(root, "person.flow_outside_repo")
  expect(rest).toEqual([])
  expect(issue!.message).not.toContain(tmp)
})

/** Checks the single `person.flow_invalid` finding for a main flow with `system` before its `uses:` names
 *  `system.paths`. */
async function systemPathsIssue(system: string) {
  const root = makeCompany({
    "shared/flows/chat.yaml": parentFlow("echo").replace("uses:", system + "uses:"),
    "shared/flows/lib/echo.yaml": CHILD,
  })
  const [issue, ...rest] = await withCode(root, "person.flow_invalid")
  expect(rest).toEqual([])
  expect(issue!.message).toContain("system.paths")
}

test("system paths is refused", async () => {
  await systemPathsIssue("system:\n  paths: [lib]\n")
})

test("system paths is refused in a flow with typed inputs", async () => {
  // A tag such as `!str` is a type to yian, not a value.
  await systemPathsIssue("input:\n  topic: !str\nsystem:\n  paths: [lib]\n")
})

test("system paths through a merge key is refused", async () => {
  await systemPathsIssue("x-base: &base\n  paths: [lib]\nsystem:\n  <<: *base\n")
})

test("unknown skill", async () => {
  const root = makeCompany({ "people/minh/person.yaml": person("minh", { skills: ["nope"] }) })
  expect(await issues(root)).toContain("person.unknown_skill people/minh/person.yaml")
})

test("personal skill is found", async () => {
  const root = makeCompany({
    "people/minh/person.yaml": person("minh", { skills: ["mine"] }),
    "people/minh/skills/mine/SKILL.md": "---\nname: mine\ndescription: Mine.\n---\nMine.\n",
  })
  expect(await codes(root)).toEqual(new Set())
})

test("invalid skill is reported", async () => {
  const root = makeCompany({ "shared/skills/broken/SKILL.md": "no frontmatter\n" })
  expect(await issues(root)).toContain("skill.invalid shared/skills/broken")
})

test("duplicate skill name in one root", async () => {
  const root = makeCompany({
    "shared/skills/review2/SKILL.md": "---\nname: code-review\ndescription: Again.\n---\nx\n",
  })
  expect(await issues(root)).toContain("skill.invalid shared/skills/review2")
})

test("a file in a skills folder is skipped", async () => {
  // Its SKILL.md path runs through a file, which stat refuses with ENOTDIR.
  expect(await lint(loadRepo(makeCompany({ "shared/skills/README.md": "# Skills\n" })))).toEqual([])
})

test("agent without profile is a warning", async () => {
  const root = makeCompany({ "people/minh/profile.md": null })
  expect(await codes(root)).toEqual(new Set())
  expect(await issues(root, "warning")).toContain("person.no_profile people/minh/profile.md")
})

test("human without profile is fine", async () => {
  expect(await codes(company(), "warning")).not.toContain("person.no_profile")
})

/** A device file entry named `name` whose token hash is `digit` 64 times. */
function device(name: string, digit = "a") {
  return { name, token_sha256: digit.repeat(64) }
}

test("an agent with devices", async () => {
  const root = makeCompany({ "people/minh/person.yaml": person("minh", { devices: [device("box")] }) })
  expect(await issues(root)).toContain("person.agent_devices people/minh/person.yaml")
})

test("two devices with one name", async () => {
  const devices = [device("mac"), device("mac", "b")]
  const root = makeCompany({ "people/ngocbh/person.yaml": person("ngocbh", { devices }) })
  const found = await withCode(root, "person.duplicate_device")
  expect(found.map((issue) => [issue.path, issue.message])).toEqual([["people/ngocbh/person.yaml", "mac"]])
})

test("a token hash two people list", async () => {
  const ava = person("ngocbh", { handle: "ava", name: "Ava", manager: "ngocbh", devices: [device("pc")] })
  const root = makeCompany({
    "people/ngocbh/person.yaml": person("ngocbh", { devices: [device("mac")] }),
    "people/ava/person.yaml": ava,
  })
  const found = (await withCode(root, "person.shared_device_token"))
    .map((issue) => [issue.path, issue.message])
    .sort()
  expect(found).toEqual([
    ["people/ava/person.yaml", "device pc's token is also listed by ngocbh"],
    ["people/ngocbh/person.yaml", "device mac's token is also listed by ava"],
  ])
  expect(JSON.stringify(found)).not.toContain("token_sha256")
  expect(JSON.stringify(found)).not.toContain("a".repeat(64))
})

test("devices with distinct names and hashes are clean", async () => {
  const devices = [device("mac"), device("pc", "b")]
  const root = makeCompany({ "people/ngocbh/person.yaml": person("ngocbh", { devices }) })
  expect(await lint(loadRepo(root))).toEqual([])
})

test("an agent with a password", async () => {
  const phc = "$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA"
  const root = makeCompany({
    "people/minh/person.yaml": person("minh", { password_hash: phc }),
    "people/ngocbh/person.yaml": person("ngocbh", { password_hash: phc }),
  })
  const found = await withCode(root, "person.agent_password")
  expect(found.map((issue) => [issue.code, issue.path]))
    .toEqual([["person.agent_password", "people/minh/person.yaml"]])
})
