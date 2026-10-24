/** People routes: the roster, who worked in a folder, and hiring. */
import { HireRequest, HireResponse, Person as PersonSchema } from "@opencorp/protocol"
import { z } from "zod"
import { HireRefused } from "../../chat/hire.ts"
import { loadRepo } from "../../company/loader.ts"
import { HttpError, type Params, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"

type Person = z.output<typeof PersonSchema>

/** `person` as the API shows them: without their password hash, which only the company repo holds. */
export function served(person: Person): Person {
  return { ...person, password_hash: null }
}

/** Everyone in the company repo. */
export function listPeople(ctx: RequestContext): Person[] {
  return [...loadRepo(ctx.office.git.root).people.values()].map(served)
}

/** People who worked in a folder, most recent first. */
export function folderPeople(ctx: RequestContext, params: Params): Person[] {
  const repo = loadRepo(ctx.office.git.root)
  const found: [string, string][] = []
  for (const handle of repo.people.keys()) {
    // -1 is SQLite's "no limit": the folder may be far down a busy person's list.
    for (const folder of ctx.office.store.workedFolders(handle, -1)) {
      if (folder.cwd === params.cwd) found.push([folder.lastAt, handle])
    }
  }
  found.sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
  found.sort(([a], [b]) => (a > b ? -1 : a < b ? 1 : 0)) // stable: ties stay in handle order
  return found.map(([, handle]) => served(repo.people.get(handle)!))
}

/** Preview a hire (writes nothing, lint issues included), or confirm the preview and commit it. */
export async function hire(ctx: RequestContext, _params: Params, body: unknown) {
  try {
    return await ctx.office.hiring.hire(body as z.output<typeof HireRequest>)
  } catch (error) {
    if (error instanceof HireRefused) throw new HttpError(422, error.code, error.message)
    throw error
  }
}

/** The people routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  // Everyone in the company repo, hand edits not yet committed included.
  { method: "GET", path: "/people", reply: z.array(PersonSchema), handler: listPeople },
  // A preview writes nothing; a confirm of an unchanged, clean preview commits.
  { method: "POST", path: "/people", body: HireRequest, reply: HireResponse, handler: hire },
  // People who worked in the folder `cwd` (URL-encoded, slashes included), most recent first.
  { method: "GET", path: "/folders/*cwd/people", reply: z.array(PersonSchema), handler: folderPeople },
]
