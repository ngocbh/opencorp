import type { HireRequest, Person, RepoIssue, Session } from "@opencorp/protocol"

export type PickerGroup = "This folder" | "Recent" | "Everyone"

/**
 * The agents to offer, each once: those who worked in this folder (most recent first), then those
 * with a recent main session anywhere (newest first), then everyone else (by handle).
 */
export function pickerRows(input: {
  people: readonly Person[]
  folderPeople: readonly Person[]
  sessions: readonly Session[]
}): { person: Person; group: PickerGroup }[] {
  const agents = new Map(input.people.filter((p) => p.kind === "agent").map((p) => [p.handle, p]))
  const rows: { person: Person; group: PickerGroup }[] = []
  const add = (handle: string, group: PickerGroup) => {
    const person = agents.get(handle)
    if (!person || rows.some((r) => r.person.handle === handle)) return
    rows.push({ person, group })
  }
  for (const p of input.folderPeople) add(p.handle, "This folder")
  for (const s of input.sessions) if (s.kind === "main") add(s.person, "Recent")
  for (const p of [...agents.values()].sort((a, b) => a.handle.localeCompare(b.handle))) add(p.handle, "Everyone")
  return rows
}

export type Harness = "composer" | "codex"
const OPENABLE: readonly Harness[] = ["composer", "codex"]

/** The harnesses a chat with `person` can run on here: their `harnesses` list (composer when empty), in its order. */
export function harnessesOf(person: Person): Harness[] {
  const listed = person.harnesses?.length ? person.harnesses : ["composer"]
  return listed.filter((h): h is Harness => (OPENABLE as readonly string[]).includes(h))
}

export type HireForm = { name: string; handle: string; title: string; manager: string }

// The protocol's `Handle` pattern; a test keeps it equal to the schema's.
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** The preview request for `form`, or what to fix first. `manager` is a handle, `@` optional. */
export function hireRequest(form: HireForm, people: readonly Person[]): { request: HireRequest } | { error: string } {
  const name = form.name.trim()
  const handle = form.handle.trim().replace(/^@/, "")
  const title = form.title.trim()
  const who = form.manager.trim().replace(/^@/, "")
  if (!name) return { error: "Name is required" }
  if (!HANDLE.test(handle)) return { error: "Handle: lowercase letters, digits and dashes, up to 32" }
  if (!title) return { error: "Title is required" }
  if (!who) return { error: "Manager is required" }
  if (!people.some((p) => p.handle === who)) return { error: `No such person: @${who}` }
  return { request: { name, handle, title, manager: who, confirm: false } }
}

/** Whether lint found an error that blocks the hire; warnings don't. */
export const blocks = (issues: readonly RepoIssue[]) => issues.some((i) => (i.severity ?? "error") === "error")

/** The confirm request: the previewed fields again; the office finds the preview by handle. */
export const confirmRequest = (previewed: HireRequest): HireRequest => ({ ...previewed, confirm: true })
