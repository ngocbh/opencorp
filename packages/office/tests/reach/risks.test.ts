/** The fixed texts the owner reads before learning the path to HQ and before saving it. */
import { expect, test } from "bun:test"
import { ReachPaths } from "../../src/reach/paths.ts"
import { BEFORE_LEARNING, beforeSaving, LEARN, LEARN_QUESTION, RELEARN_QUESTION } from "../../src/reach/risks.ts"

/** Each line holds every one of its phrases, in the design's order of risks. */
function expectRisks(lines: readonly string[], phrases: string[][]): void {
  expect(lines).toHaveLength(phrases.length)
  lines.forEach((line, i) => {
    for (const phrase of phrases[i]!) expect(line).toContain(phrase)
  })
}

test("the fixed risks are the design's, and the provider file is named", () => {
  expectRisks(BEFORE_LEARNING, [
    ["model", "each command it runs", "output and errors", "hostnames", "username", "paths", "job lists"],
    ["Approving a command runs it as you", "SSH keys", "only you check it"],
  ])
  const saving = beforeSaving(new ReachPaths("/h"))
  expectRisks(saving, [
    ["The script", "`opencorp hq --check` on HQ's machine", "now and on every visit"],
    ["While `opencorp hq` runs", "anything running as you on this machine", "SSH connections without Duo", "60 s"],
    [
      "reach the port reaches HQ",
      "sign in",
      "SameSite=Strict",
      "Host header",
      "don't run `opencorp hq` on a machine others share",
      "cluster login node",
      "127.0.0.1",
    ],
    ["new node", "host key", "the way your cluster documents"],
    ["cluster's layout", "backups copy them"],
    ["/h/hq/provider.json holds a key or a token"],
  ])
  expect(saving.at(-1)).toBe("/h/hq/provider.json holds a key or a token.")
  expect(LEARN).toBe("Learn it")
  expect(LEARN_QUESTION).toContain("uses the model")
  expect(RELEARN_QUESTION).toContain("uses the model")
})
