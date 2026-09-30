import { expect, test } from "bun:test"
import type { Message } from "@agent-corp/protocol"
import { aboutTurn, turns } from "../../../src/routes/debrief/debrief"

const msg = (role: Message["role"], ...texts: string[]) =>
  ({ role, parts: texts.map((text) => ({ type: "text", text })) }) as unknown as Message

test("turns are the user's messages in order, numbered from 1, by their first line", () => {
  const list = [
    msg("user", "Fix the flaky test\nIt fails on CI"),
    msg("assistant", "On it"),
    msg("user", "", "Use a fake clock"),
    msg("user"),
  ]
  expect(turns(list)).toEqual([
    { n: 1, text: "Fix the flaky test" },
    { n: 2, text: "Use a fake clock" },
    { n: 3, text: "" },
  ])
})

test("aboutTurn is the feedback pre-fill: it quotes the turn's first 60 characters", () => {
  expect(aboutTurn({ n: 3, text: "Use a fake clock" })).toBe('About turn 3 ("Use a fake clock"): ')
  const long = "Rewrite the retry loop so that it backs off exponentially and gives up after a minute"
  expect(aboutTurn({ n: 1, text: long })).toBe(`About turn 1 ("${long.slice(0, 60)}…"): `)
  expect(aboutTurn({ n: 2, text: "" })).toBe("About turn 2: ")
})
