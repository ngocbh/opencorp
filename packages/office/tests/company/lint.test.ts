/** Checking a loaded company repo (Python's `tests/company/test_lint.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import { lint } from "../../src/company/lint.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { assetToolName } from "../../src/company/naming.ts"
import { baseFiles, company, makeCompany, person } from "./helpers.ts"

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
