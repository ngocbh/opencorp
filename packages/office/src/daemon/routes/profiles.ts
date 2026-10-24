/** Profile routes: read and edit a person's profile.md through the office's MarkdownStore. */
import { type MarkdownStore, MarkdownVersionMismatch } from "@ngocbh/yian"
import { CompanyDefaults, Profile, ProfileWriteRequest, VersionConflict } from "@opencorp/protocol"
import { loadRepo } from "../../company/loader.ts"
import { HttpError, RawReply, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"

/** `handle`'s profile store and the profile budget in characters; 501 without a profile store, 404 for no such
 *  person. */
function open(ctx: RequestContext, handle: string, method: string): { store: MarkdownStore; maxChars: number } {
  const factory = ctx.office.profileStore
  if (factory === null) {
    throw new HttpError(501, "not_implemented", `${method} /profiles/${handle} is not implemented yet`)
  }
  const repo = loadRepo(ctx.office.git.root)
  if (!repo.people.has(handle)) throw new HttpError(404, "not_found", `no person ${handle}`)
  const maxChars = (repo.company?.defaults ?? CompanyDefaults.parse({})).profile_max_chars
  return { store: factory(handle), maxChars }
}

/** Whether `text` is longer than `maxChars`, counting code points as Python's `len` did. */
function overBudget(text: string, maxChars: number): boolean {
  return [...text].length > maxChars
}

/** The profile routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  // A person's profile text and version.
  {
    method: "GET",
    path: "/profiles/:handle",
    reply: Profile,
    handler: async (ctx, params): Promise<Profile> => {
      const handle = params.handle!
      const { store, maxChars } = open(ctx, handle, "GET")
      const [text, version] = await store.read()
      return { person: handle, text, version, over_budget: overBudget(text, maxChars) }
    },
  },
  // Replaces a profile if `base_version` is current; 409 with both versions if not.
  {
    method: "PUT",
    path: "/profiles/:handle",
    guard: (ctx, params) => {
      open(ctx, params.handle!, "PUT")
    },
    body: ProfileWriteRequest,
    reply: Profile,
    handler: async (ctx, params, body) => {
      const handle = params.handle!
      const { text, base_version } = body as ProfileWriteRequest
      // The guard's result can't reach the handler, and the load is cheap.
      const { store, maxChars } = open(ctx, handle, "PUT")
      let version: string
      try {
        version = await store.write(text, { baseVersion: base_version, provenance: { source: "hand edit" } })
      } catch (error) {
        if (!(error instanceof MarkdownVersionMismatch)) throw error
        const conflict = VersionConflict.parse({ expected: error.expected, current: error.current })
        return new RawReply(409, {}, JSON.stringify(conflict))
      }
      const profile = Profile.parse({ person: handle, text, version, over_budget: overBudget(text, maxChars) })
      ctx.office.store.emit("profile.updated", handle, profile)
      return profile
    },
  },
]
