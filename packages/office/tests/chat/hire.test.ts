/** Hiring: a new agent's files, laid out as the Python office wrote them, and previews of a hire. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { HireRequest, Person } from "@opencorp/protocol"
import { agentFiles, Hiring } from "../../src/chat/hire.ts"
import { CompanyGit } from "../../src/company/git.ts"
import { readYaml } from "../../src/company/flow_yaml.ts"
import { baseFiles, gitEnv, writeRepo } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"
import { CHAT_FLOW } from "./helpers.ts"

setDefaultTimeout(30_000)

const FORM = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }

function req(form: Record<string, unknown>, confirm = false) {
  return HireRequest.parse({ ...form, confirm })
}

function makeGit(files: Record<string, unknown> = { ...baseFiles(), "shared/flows/chat.yaml": CHAT_FLOW }) {
  const dir = tempDir()
  return new CompanyGit(writeRepo(path.join(dir, "company"), files), path.join(dir, "worktrees"))
}

// Untrimmed: the helper's trim would eat the leading space of " M ...".
function status(root: string): string {
  return spawnSync("git", ["-C", root, "status", "--porcelain"], { env: gitEnv(), encoding: "utf8" }).stdout
}
// Dumped from the frozen Python office.
const GOLDEN = {
  "people/lan/person.yaml":
    "handle: lan\nname: Lan\nkind: agent\ntitle: QA\nmanager: ngocbh\n" +
    "main: ../../shared/flows/chat.yaml\nharnesses:\n- composer\nharness_policy:\n  sandbox: workspace-write\n",
  "people/lan/profile.md": "# Lan, QA\n",
}

test("a hires person file is laid out as python wrote it", () => {
  const [person, files] = agentFiles(FORM)
  expect(files).toEqual(GOLDEN)
  expect(Person.parse(readYaml(files["people/lan/person.yaml"]!))).toEqual(person)
})

test("a hostile title reads back as itself and adds no key", () => {
  const keys = Object.keys(readYaml(GOLDEN["people/lan/person.yaml"]) as object)
  const titles = ["QA\nkind: human", "QA\npassword_hash: x", "yes", "0755", "null", "~", "- x", "a: b", "x #y", " lead"]
  for (const title of [...titles, " ", "x".repeat(200)]) {
    const body = readYaml(agentFiles({ ...FORM, title })[1]["people/lan/person.yaml"]!) as Record<string, unknown>
    expect([Object.keys(body), body.title]).toEqual([keys, title])
  }
})

test("a taken handle is refused and names the clash", async () => {
  const git = makeGit()
  const preview = await new Hiring(git).hire(req({ ...FORM, handle: "minh" }))
  expect(preview.commit).toBeNull()
  expect(preview.issues.map((i) => [i.path, i.code, i.message, i.severity])).toEqual([
    ["people/minh/person.yaml", "person.duplicate_handle", "@minh is already taken", "error"],
  ])
})

test("a folder left by hand takes the handle", async () => {
  const git = makeGit()
  fs.mkdirSync(path.join(git.root, "people/lan"))
  const preview = await new Hiring(git).hire(req(FORM))
  expect(preview.issues.map((i) => i.code)).toEqual(["person.duplicate_handle"])
})

test("an unknown manager is a lint error", async () => {
  const preview = await new Hiring(makeGit()).hire(req({ ...FORM, manager: "kai" }))
  expect(preview.issues.some((i) => i.severity === "error" && i.message.includes("kai"))).toBe(true)
})

test("a preview leaves hand edits alone", async () => {
  const git = makeGit()
  fs.writeFileSync(path.join(git.root, "people/minh/profile.md"), "# Minh, Engineer\n\nLikes tests.\n")
  const head = await git.head()
  await new Hiring(git).hire(req(FORM))
  expect([await git.head(), status(git.root)]).toEqual([head, " M people/minh/profile.md\n"])
})

test("issue messages name the company repo not the scratch copy", async () => {
  const check =
    "  check:\n    kind: code\n    code: ./nope.ts:fn\n    input:\n      x: ${ask.output}\n    output: str\n"
  const flow = CHAT_FLOW.replace("output: ${reply.output}\n", check + "output: ${reply.output}\n")
  const git = makeGit({ ...baseFiles(), "shared/flows/chat.yaml": flow })
  const preview = await new Hiring(git).hire(req(FORM))
  const named = preview.issues.filter((i) => i.message.includes("nope.ts"))
  expect(named.length).toBeGreaterThan(0)
  for (const issue of named) {
    expect(issue.message).toContain(`${fs.realpathSync(git.root)}/shared/flows`)
    expect(issue.message).not.toContain("opencorp-hire-")
  }
  expect(named.find((i) => i.path === "people/lan/person.yaml")?.severity).toBe("error")
  expect(named.find((i) => i.path === "people/minh/person.yaml")?.severity).toBe("warning")
})
