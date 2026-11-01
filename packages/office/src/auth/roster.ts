/** Who may act: the CEO and the humans' device token hashes at the company repo's HEAD. */
import { Company, Person as PersonSchema } from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyGit } from "../company/git.ts"
import { parseFile, type RepoIssue, repoIssue } from "../company/issues.ts"

type Person = z.output<typeof PersonSchema>

/** A person file at HEAD that doesn't load: its repo path and the RepoIssue code, never the issue's message. */
export type Unreadable = { readonly path: string; readonly code: string }

/** The CEO and `{token_sha256: [handle, device]}` at commit `head`; `enforced` says whether every request
 *  needs a token: once any human lists a device. `unreadable` lists the person files that don't load. An agent
 *  named CEO is no CEO: agents never act for a request. */
export class Roster {
  constructor(
    readonly head: string,
    readonly ceo: string | null,
    readonly tokens: ReadonlyMap<string, readonly [string, string]> = new Map(),
    readonly enforced = false,
    readonly unreadable: readonly Unreadable[] = [],
  ) {}

  /** The roster of `people` at `head`, with the person files that didn't load. */
  static of(head: string, ceo: string | null, people: Iterable<Person>, unreadable: readonly Unreadable[] = []): Roster {
    const list = [...people]
    const enforced = list.some((p) => p.kind === "human" && p.devices.length > 0)
    if (list.some((p) => p.handle === ceo && p.kind !== "human")) ceo = null
    return new Roster(head, ceo, tokenTable(list), enforced, unreadable)
  }
}

/** `{token_sha256: [handle, device]}` over the humans' devices. Agents' devices are ignored, and a hash
 *  two people list is left out: it can't say who acts. */
export function tokenTable(people: Iterable<Person>): Map<string, readonly [string, string]> {
  const owners = new Map<string, Map<string, string>>()
  for (const person of people) {
    if (person.kind !== "human") continue
    for (const device of person.devices) {
      const by = owners.get(device.token_sha256) ?? new Map<string, string>()
      owners.set(device.token_sha256, by)
      if (!by.has(person.handle)) by.set(person.handle, device.name)
    }
  }
  const table = new Map<string, readonly [string, string]>()
  for (const [hash, by] of owners) if (by.size === 1) table.set(hash, [...by][0]!)
  return table
}

/** `data` parsed as `schema`, or null when missing or broken; the problem is recorded in `issues`. */
function parse<S extends z.ZodObject>(
  path: string,
  data: Buffer | undefined,
  schema: S,
  issues: RepoIssue[],
): z.output<S> | null {
  if (data === undefined) {
    issues.push(repoIssue(path, "repo.unreadable", "can't be read"))
    return null
  }
  return parseFile(path, data, schema, issues)
}

/** The roster at commit `head`, read from git objects, so uncommitted edits don't count. */
export async function loadRoster(git: CompanyGit, head: string): Promise<Roster> {
  const companyBlob = await git.blobId("company.yaml", head)
  const personBlobs = new Map<string, [path: string, blob: string]>()
  for (const [path, blob] of await git.files("people", head)) {
    const parts = path.split("/")
    if (parts.length === 3 && path.endsWith("/person.yaml")) personBlobs.set(parts[1]!, [path, blob])
  }
  // One read for every file: a git call per person would make each reload grow with the company.
  const ids = [companyBlob, ...[...personBlobs.values()].map(([, blob]) => blob)].filter((b): b is string => !!b)
  const data = await git.readBlobs(ids)
  const company = companyBlob ? parse("company.yaml", data.get(companyBlob), Company, []) : null
  const people: Person[] = []
  // A broken person file lets no one in through it; lint reports it in full.
  const issues: RepoIssue[] = []
  for (const [handle, [path, blob]] of personBlobs) {
    const person = parse(path, data.get(blob), PersonSchema, issues)
    if (person === null) continue
    if (person.handle === handle) people.push(person)
    else issues.push(repoIssue(path, "person.dir_mismatch", "the handle must match its directory"))
  }
  return Roster.of(head, company?.ceo ?? null, people, issues.map(({ path, code }) => ({ path, code })))
}
