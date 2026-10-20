import type { Person } from "@opencorp/protocol"

/** A person for tests: human `ceo`, agents otherwise, named after their handle. */
export const person = (handle: string, manager: string | null, over: Partial<Person> = {}): Person => ({
  handle,
  name: handle[0].toUpperCase() + handle.slice(1),
  kind: handle === "ceo" ? "human" : "agent",
  title: "T",
  manager,
  groups: [],
  devices: [],
  password_hash: null,
  ...over,
})
