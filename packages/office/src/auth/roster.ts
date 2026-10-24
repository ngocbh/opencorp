/** Who may act: the CEO and the humans' device token hashes at the company repo's HEAD. */
import { Company, Person as PersonSchema } from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyGit } from "../company/git.ts"
import { parseFile } from "../company/issues.ts"

type Person = z.output<typeof PersonSchema>

/** The CEO and `{token_sha256: [handle, device]}` at commit `head`; `enforced` says whether every request
 *  needs a token: once any human lists a device. */
export class Roster {
  constructor(
    readonly head: string,
    readonly ceo: string | null,
    readonly tokens: ReadonlyMap<string, readonly [string, string]> = new Map(),
    readonly enforced = false,
  ) {}

  /** The roster of `people` at `head`. */
  static of(head: string, ceo: string | null, people: Iterable<Person>): Roster {
    const list = [...people]
    return new Roster(head, ceo, tokenTable(list), list.some((p) => p.kind === "human" && p.devices.length > 0))
  }
}

/** `{token_sha256: [handle, device]}` over the humans' devices. Agents' devices are ignored, and a hash
 *  two people list is left out: it can't say who acts. */
export function tokenTable(people: Iterable<Person>): Map<string, readonly [string, string]> {
  const owners = new Map<string, Map<string, string>>()
  for (const person of people) {
    if (person.kind !== "human") continue
    for (const device of person.devices) {
      let by = owners.get(device.token_sha256)
      if (!by) owners.set(device.token_sha256, (by = new Map()))
      if (!by.has(person.handle)) by.set(person.handle, device.name)
    }
  }
  const table = new Map<string, readonly [string, string]>()
  for (const [hash, by] of owners) if (by.size === 1) table.set(hash, [...by][0]!)
  return table
}

/** `data` parsed as `schema`, or null when empty or broken. */
function parse<S extends z.ZodObject>(path: string, data: Buffer | undefined, schema: S): z.output<S> | null {
  // Lint reports a broken file; here it just lets no one in through it.
  return data?.length ? parseFile(path, data, schema, []) : null
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
  const company = companyBlob ? parse("company.yaml", data.get(companyBlob), Company) : null
  const people: Person[] = []
  for (const [handle, [path, blob]] of personBlobs) {
    const person = parse(path, data.get(blob), PersonSchema)
    if (person !== null && person.handle === handle) people.push(person)
  }
  return Roster.of(head, company?.ceo ?? null, people)
}
