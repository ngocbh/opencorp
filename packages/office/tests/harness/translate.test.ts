/** Codex items as transcript parts, and server requests as cards with their replies. */
import fs from "node:fs"
import { Ajv } from "ajv"
import { expect, test } from "bun:test"
import { changeCounts, REFUSED, SERVED } from "../../src/harness/translate.ts"

const FIXTURES = new URL("../fixtures/codex/", import.meta.url)
/** The recorded sessions' names, without `.jsonl`, sorted. */
const RECORDED = fs.readdirSync(new URL("sessions/", FIXTURES)).filter((name) => name.endsWith(".jsonl"))
  .map((name) => name.slice(0, -".jsonl".length)).sort()

// Python's Draft7Validator checks no `format`.
const ajv = new Ajv({ strict: false, validateFormats: false })

/** A JSON object from the wire: `any`, since the assertions read whatever Codex sent. */
type Msg = Record<string, any>

// --- file changes ------------------------------------------------------------------------

test.each([
  ["add", "one\ntwo\n", [2, 0]],  // Codex sends a new file's content
  ["delete", "one\n+two\n-three\n", [0, 3]],  // and a deleted file's content
  ["update", "@@ -1,2 +1,2 @@\n-z\n+x\n+y\n keep\n", [2, 1]],
  ["update", "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: b.py", [1, 1]],
  ["update", "--- a/f\n+++ b/f\n@@ -1 +1 @@\n--- x\n+++ y\n", [1, 1]],  // headers, then lines "-- x" and "++ y"
] as [string, string, [number, number]][])("a file changes lines are counted by its kind [%s]", (kind, diff, counts) => {
  expect(changeCounts(kind, diff)).toEqual(counts)
})

// --- the pinned schema -------------------------------------------------------------------

test("every server request in the pinned schema is served or refused", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("schema/ServerRequest.json", FIXTURES), "utf8"))
  const methods = new Set<string>(schema.oneOf.flatMap((branch: Msg) => branch.properties.method.enum))
  const known = new Set([...SERVED, ...REFUSED])
  const added = [...methods].filter((m) => !known.has(m)).sort()
  const gone = [...known].filter((m) => !methods.has(m)).sort()
  expect([added, gone], `new: ${JSON.stringify(added)}; gone: ${JSON.stringify(gone)}`).toEqual([[], []])
})

// --- the recorded real sessions ----------------------------------------------------------

test("the recordings include the core scenarios", () => {
  const core = ["plain", "command-approve", "command-decline", "file-change", "interrupt", "steer", "resume"]
  for (const scenario of core) expect(RECORDED.includes(scenario), scenario).toBe(true)
})

test.each(RECORDED)("each recorded agent messages deltas add up to its completed text [%s]", (name) => {
  // Only agent messages: real Codex can leave a command's first output line out of its deltas (steer.jsonl).
  const deltas = new Map<string, string>()
  const texts = new Map<string, string>()
  const lines = fs.readFileSync(new URL(`sessions/${name}.jsonl`, FIXTURES), "utf8").split("\n").filter((line) => line)
  for (const line of lines) {
    const msg: Msg = JSON.parse(line).msg
    if (msg.method === "item/agentMessage/delta") {
      deltas.set(msg.params.itemId, (deltas.get(msg.params.itemId) ?? "") + msg.params.delta)
    } else if (msg.method === "item/completed" && msg.params.item.type === "agentMessage") {
      texts.set(msg.params.item.id, msg.params.item.text)
    }
  }
  for (const [id, text] of deltas) {
    expect(texts.has(id), id).toBe(true)
    expect(text).toBe(texts.get(id)!)
  }
})
