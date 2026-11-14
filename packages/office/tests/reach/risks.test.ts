/** The fixed texts the owner reads before learning the path to HQ and before saving it. */
import { expect, test } from "bun:test"
import { ReachPaths } from "../../src/reach/paths.ts"
import { beforeLearning, beforeSaving, LEARN, LEARN_QUESTION, RELEARN_QUESTION } from "../../src/reach/risks.ts"
import { LEARNING_PERSIST_S, PERSIST_S } from "../../src/reach/ssh.ts"

/** Each line holds every one of its phrases, in the design's order of risks. */
function expectRisks(lines: readonly string[], phrases: string[][]): void {
  expect(lines).toHaveLength(phrases.length)
  lines.forEach((line, i) => {
    for (const phrase of phrases[i]!) expect(line).toContain(phrase)
  })
}

test("the fixed risks are the design's, and the provider file is named", () => {
  expectRisks(beforeLearning(new ReachPaths("/h")), [
    ["model", "each command it runs", "output and errors", "hostnames", "username", "paths", "job lists"],
    ["Approving a command runs it as you", "SSH keys", "only you check it"],
    ["While learning runs", "anything running as you on this machine", "SSH connections without Duo"],
    ["/h/hq holds the model's key or its ChatGPT sign-in", "don't approve a command that reads it"],
  ])
  const saving = beforeSaving(new ReachPaths("/h"))
  expectRisks(saving, [
    ["The script", "`opencorp hq --check` on HQ's machine", "now and on every visit"],
    [
      "While `opencorp hq` runs",
      "anything running as you on this machine",
      "SSH connections without Duo",
      "the login node's for 60 s more",
      "10 minutes on a visit that learned its path",
    ],
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
    ["/h/hq/provider.json", "/h/hq/auth.json", "the model's key or its ChatGPT sign-in"],
  ])
  expect(saving.at(-1)).toBe("/h/hq/provider.json or /h/hq/auth.json holds the model's key or its ChatGPT sign-in.")
  expect(LEARN).toBe("Learn it")
  expect(LEARN_QUESTION).toContain("uses the model")
  expect(RELEARN_QUESTION).toContain("uses the model")
})

/** The texts as risks.ts held them before they moved to risks.md. */
const HELD = {
  beforeLearning: (paths: ReachPaths): string[] => [
    "Learning uses a model, which sees each command it runs and their output and errors: hostnames, your username, paths and job lists.",
    "Approving a command runs it as you, with your SSH keys, and only you check it.",
    "While learning runs, anything running as you on this machine can reuse its SSH connections without Duo.",
    `${paths.dir} holds the model's key or its ChatGPT sign-in: don't approve a command that reads it.`,
  ],
  beforeSaving: (paths: ReachPaths): string[] => [
    "The script, and `opencorp hq --check` on HQ's machine, run now and on every visit.",
    "While `opencorp hq` runs, anything running as you on this machine can reuse its SSH connections without Duo. A crash or `kill -9` closes them within seconds; only if its watcher dies too (`kill -9` of its process group) do they stay while an HQ tab is open, " +
      `the login node's for ${PERSIST_S} s more (${LEARNING_PERSIST_S / 60} minutes on a visit that learned its path).`,
    "Anything on this machine that can reach the port reaches HQ, though HQ still asks it to sign in (its cookie is SameSite=Strict, and the Host header is checked). So don't run `opencorp hq` on a machine others share, such as a cluster login node: they share 127.0.0.1.",
    "Each new node HQ runs on asks you to accept its host key; check it the way your cluster documents.",
    "The saved files record the cluster's layout, and backups copy them.",
    `${paths.provider} or ${paths.auth} holds the model's key or its ChatGPT sign-in.`,
  ],
  LEARN: "Learn it",
  LEARN_QUESTION: "Learn how to reach HQ from here? This uses the model.",
  RELEARN_QUESTION: "Relearn? This uses the model.",
}

test("risks.md holds the texts risks.ts held, byte for byte, whatever the hq folder's path holds", () => {
  for (const home of ["/h", "/h/we$&ird$`{auth}"]) {
    const paths = new ReachPaths(home)
    expect(beforeLearning(paths)).toEqual(HELD.beforeLearning(paths))
    expect(beforeSaving(paths)).toEqual(HELD.beforeSaving(paths))
  }
  expect([LEARN, LEARN_QUESTION, RELEARN_QUESTION]).toEqual([HELD.LEARN, HELD.LEARN_QUESTION, HELD.RELEARN_QUESTION])
})
