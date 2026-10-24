/** The company at one commit of the office's clone: the company file, people and groups, from git objects. */
import {
  Company as CompanySchema,
  CompanyView as CompanyViewSchema,
  Group as GroupSchema,
  Person as PersonSchema,
} from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyGit } from "./git.ts"
import { parseFile, type RepoIssue, repoIssue } from "./issues.ts"
import { blankSecrets } from "./secret_keys.ts"

type Company = z.output<typeof CompanySchema>
type CompanyView = z.output<typeof CompanyViewSchema>
type Person = z.output<typeof PersonSchema>
type Group = z.output<typeof GroupSchema>

/** How many `/` are in `path`. */
function depth(path: string): number {
  return path.split("/").length - 1
}

/** The keys of `map`, sorted by code unit. */
function sortedKeys(map: Map<string, string>): string[] {
  return [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * The company at commit `sha`, read in one batch from git objects, so uncommitted edits don't count.
 *
 * People come without their devices and password hash.
 */
export async function loadCompanyAt(git: CompanyGit, sha: string): Promise<CompanyView> {
  const [companyBlob, allPeople, allGroups] = await Promise.all([
    git.blobId("company.yaml", sha),
    git.files("people", sha),
    git.files("groups", sha),
  ])
  const people = new Map([...allPeople].filter(([rel]) => depth(rel) === 2 && rel.endsWith("/person.yaml")))
  const groups = new Map([...allGroups].filter(([rel]) => depth(rel) === 1 && rel.endsWith(".yaml")))
  // One read for every file: a git call per person would make each load grow with the company.
  const ids = [...(companyBlob ? [companyBlob] : []), ...people.values(), ...groups.values()]
  const data = await git.readBlobs(ids)
  // A blob git didn't return (a folder named company.yaml) reads as an empty file, so it's a schema issue.
  const bytes = (id: string) => data.get(id) ?? new Uint8Array()
  const issues: RepoIssue[] = []
  let company: Company | null = null
  if (companyBlob === null) {
    issues.push(repoIssue("company.yaml", "repo.unreadable", "company.yaml is missing"))
  } else {
    company = parseFile("company.yaml", bytes(companyBlob), CompanySchema, issues)
  }
  const found: Person[] = []
  for (const path of sortedKeys(people)) {
    const person = parseFile(path, bytes(people.get(path)!), PersonSchema, issues)
    const folder = path.split("/")[1]!
    if (person !== null && person.handle !== folder) {
      issues.push(repoIssue(path, "person.dir_mismatch",
        `the handle must match its directory ${JSON.stringify(folder)}`))
    } else if (person !== null) {
      // The view goes to browsers, and the schema can't keep these out since it reuses Person.
      found.push(blankSecrets(PersonSchema, person))
    }
  }
  const teams: Group[] = []
  for (const path of sortedKeys(groups)) {
    const group = parseFile(path, bytes(groups.get(path)!), GroupSchema, issues)
    const stem = path.slice("groups/".length, -".yaml".length)
    if (group !== null && group.id !== stem) {
      issues.push(repoIssue(path, "repo.file_mismatch",
        `the id must match its file name ${JSON.stringify(stem)}`))
    } else if (group !== null) {
      teams.push(group)
    }
  }
  return { sha, company, people: found, groups: teams, issues }
}

/**
 * `loadCompanyAt` by sha, loaded once however many callers ask at the same time.
 *
 * Every HQ request checks its person at the newest HEAD, so a HEAD move would otherwise start one load per
 * request. The last `KEEP` loads are kept.
 */
export class CompanySnapshots {
  static readonly KEEP = 4
  readonly #done = new Map<string, CompanyView>()
  readonly #loading = new Map<string, Promise<CompanyView>>()
  readonly git: CompanyGit

  constructor(git: CompanyGit) {
    this.git = git
  }

  /** The company at `sha`. */
  at(sha: string): Promise<CompanyView> {
    const view = this.#done.get(sha)
    if (view !== undefined) return Promise.resolve(view)
    let load = this.#loading.get(sha)
    if (load === undefined) {
      load = loadCompanyAt(this.git, sha)
      this.#loading.set(sha, load)
      // Callers get `load` itself and see its error; this handler only settles the bookkeeping, and
      // catching here keeps the rejection from counting as unobserved.
      load.then(
        (loaded) => {
          this.#loading.delete(sha)
          this.#done.set(sha, loaded)
          // Maps iterate in insertion order, so the first key is the oldest load.
          while (this.#done.size > CompanySnapshots.KEEP) this.#done.delete(this.#done.keys().next().value!)
        },
        () => {
          this.#loading.delete(sha)
        },
      )
    }
    return load
  }

  /** The company at the clone's HEAD; null before its first commit. */
  async head(): Promise<CompanyView | null> {
    let sha: string
    try {
      sha = await this.git.readHead()
    } catch (error) {
      if (error instanceof RangeError) return null
      throw error
    }
    return this.at(sha)
  }
}
