/** Load a company repo's working tree into validated protocol models. */
import fs from "node:fs"
import path from "node:path"
import {
  Asset as AssetSchema,
  Company as CompanySchema,
  Group as GroupSchema,
  Person as PersonSchema,
} from "@opencorp/protocol"
import type { z } from "zod"
import { parseFile, type RepoIssue, repoIssue } from "./issues.ts"

type Company = z.output<typeof CompanySchema>
type Person = z.output<typeof PersonSchema>
type Group = z.output<typeof GroupSchema>
type Asset = z.output<typeof AssetSchema>

/** One company repo checkout, parsed: people by handle, groups and assets by id. Files that fail to
 *  parse are in `errors`. */
export interface CompanyRepo {
  readonly root: string
  readonly company: Company | null
  readonly people: ReadonlyMap<string, Person>
  readonly groups: ReadonlyMap<string, Group>
  readonly assets: ReadonlyMap<string, Asset>
  readonly errors: readonly RepoIssue[]
}

/** The names in `dir`, sorted; none if it can't be listed. */
function list(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return []
  }
}

/** The file at repo path `rel` parsed by `schema`; a problem is recorded in `errors` and gives null. */
function parse<S extends z.ZodObject>(root: string, rel: string, schema: S, errors: RepoIssue[]): z.output<S> | null {
  let data: Uint8Array
  try {
    data = fs.readFileSync(path.join(root, rel))
  } catch (error) {
    // The OS error's message quotes the absolute path, so only fixed text leaves.
    const missing = rel === "company.yaml" && (error as NodeJS.ErrnoException).code === "ENOENT"
    errors.push(repoIssue(rel, "repo.unreadable", missing ? "company.yaml is missing" : "can't be read"))
    return null
  }
  return parseFile(rel, data, schema, errors)
}

/** Each `<folder>/<id>.yaml` under `root` parsed by `schema`, by id; problems go to `errors`. */
function byId<S extends typeof GroupSchema | typeof AssetSchema>(
  root: string,
  folder: string,
  schema: S,
  errors: RepoIssue[],
): Map<string, z.output<S>> {
  const items = new Map<string, z.output<S>>()
  for (const name of list(path.join(root, folder)).filter((name) => name.endsWith(".yaml"))) {
    const rel = `${folder}/${name}`
    const stem = name.slice(0, -".yaml".length)
    const item = parse(root, rel, schema, errors)
    if (item === null) continue
    if (item.id !== stem) {
      errors.push(repoIssue(rel, "repo.file_mismatch",
        `id ${JSON.stringify(item.id)} must match its file name ${JSON.stringify(stem)}`))
    } else {
      items.set(item.id, item)
    }
  }
  return items
}

/** Parses `company.yaml`, people, groups and assets under `root`. */
export function loadRepo(root: string): CompanyRepo {
  try {
    root = fs.realpathSync(root)
  } catch {
    root = path.resolve(root)
  }
  const errors: RepoIssue[] = []
  const company = parse(root, "company.yaml", CompanySchema, errors)
  const people = new Map<string, Person>()
  for (const folder of list(path.join(root, "people"))) {
    // A listing matches the name exactly where a lookup may ignore case (macOS), as the glob and git do. It
    // follows a symlinked folder, gives nothing for a file and keeps a dangling person.yaml link.
    if (!list(path.join(root, "people", folder)).includes("person.yaml")) continue
    const rel = `people/${folder}/person.yaml`
    const person = parse(root, rel, PersonSchema, errors)
    if (person === null) continue
    if (person.handle !== folder) {
      errors.push(repoIssue(rel, "person.dir_mismatch",
        `handle ${JSON.stringify(person.handle)} must match its directory ${JSON.stringify(folder)}`))
    } else {
      people.set(person.handle, person)
    }
  }
  const groups = byId(root, "groups", GroupSchema, errors)
  const assets = byId(root, "assets", AssetSchema, errors)
  return { root, company, people, groups, assets, errors }
}

/** Why `repo` has no person `handle`, for a 404: their person.yaml doesn't load, or there is no such person. The
 *  issue's message stays out, so the reply points to `opencorp doctor`. */
export function missingPerson(repo: CompanyRepo, handle: string): string {
  // Matched against paths from the folder listing, so a handle with a slash or dots never matches.
  const rel = `people/${handle}/person.yaml`
  const broken = repo.errors.some((issue) => issue.path === rel)
  return broken ? `@${handle}'s person.yaml doesn't load; run \`opencorp doctor\`` : `no person ${handle}`
}
