/** Hiring: a new agent's files, laid out as the Python office wrote them. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { Person } from "@opencorp/protocol"
import { agentFiles } from "../../src/chat/hire.ts"
import { readYaml } from "../../src/company/flow_yaml.ts"

setDefaultTimeout(30_000)

const FORM = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
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
  const titles = ["QA\nkind: human", "QA\npassword_hash: x", "yes", "0755", "null", "~", "- x", "a: b", "x #y", " lead", " "]
  for (const title of [...titles, "x".repeat(200)]) {
    const body = readYaml(agentFiles({ ...FORM, title })[1]["people/lan/person.yaml"]!) as Record<string, unknown>
    expect([Object.keys(body), body.title]).toEqual([keys, title])
  }
})
