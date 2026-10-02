// Type-checked by tsc, not run by bun test.
import type { AnswerRequest, HireRequest, Message, Person, Question } from "../src/index"

export const minh: Person = {
  handle: "minh", name: "Minh", kind: "agent", title: "Engineer", manager: "ngocbh",
}

export const ceo: Person = {
  handle: "ngocbh", name: "Hong Ngoc Bui", kind: "human", title: "CEO", manager: null,
  devices: [{ name: "macbook", token_sha256: "d07f963c2bb7a3cc74a910e51ca0075b194da412a93737881f105a55156a988f" }],
  password_hash: "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$Z2lHqGqVnSkfU3gS2tlFp2Yzqm7AAw0EC5lyE4X4bMI",
}

export const badKind: Person = {
  // @ts-expect-error kind is "human" | "agent"
  handle: "x", name: "X", kind: "robot", title: "T", manager: null,
}

export const extraField: Person = {
  handle: "x", name: "X", kind: "human", title: "T", manager: null,
  // @ts-expect-error unknown fields are rejected
  colour: "blue",
}

export const message: Message = {
  id: "01JA1M0000000000000000000A", session_id: "01JA1S0000000000000000000A", role: "assistant",
  created_at: "2026-09-29T10:00:05.000Z",
  parts: [{ id: "01JA1P0000000000000000000A", type: "text", text: "hi" }],
}

export const page: Question["questions"] = [
  { question: "Which database?", header: "Database", options: [{ label: "Postgres" }], multi_select: false },
]

export const hire: HireRequest = { name: "Ava", handle: "ava", title: "Researcher", manager: "ngocbh" }

export const officeOnlyKind: AnswerRequest = {
  answer: "Postgres",
  // @ts-expect-error sent_back and interrupted are set by the office, not a client
  answer_kind: "sent_back",
}
