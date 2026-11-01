/** Profile routes: read and edit a person's profile.md through the office's MarkdownStore, and list and apply the
 *  profile manager's proposals. */
import { type MarkdownStore, MarkdownVersionMismatch } from "@ngocbh/yian"
import {
  CompanyDefaults,
  Profile,
  ProfileManagerRequest,
  ProfileProposal,
  ProfileWriteRequest,
  Session,
  VersionConflict,
} from "@opencorp/protocol"
import { z } from "zod"
import { type CompanyRepo, loadRepo, missingPerson } from "../../company/loader.ts"
import { applyProposal, ProposalNotFound, ProposalNotOpen } from "../../profile/manager.ts"
import { actingPerson } from "../auth.ts"
import { HttpError, RawReply, type Route } from "../http.ts"
import type { RequestContext, SessionHarness } from "../office.ts"
import { harnessCall } from "./sessions.ts"

/** The company repo in the working tree; 404 for no person `handle`, or one whose person.yaml doesn't load. */
function withPerson(ctx: RequestContext, handle: string): CompanyRepo {
  const repo = loadRepo(ctx.office.git.root)
  if (!repo.people.has(handle)) throw new HttpError(404, "not_found", missingPerson(repo, handle))
  return repo
}

/** The profile budget in characters: the company defaults' `profile_max_chars`. */
function maxCharsOf(repo: CompanyRepo): number {
  return (repo.company?.defaults ?? CompanyDefaults.parse({})).profile_max_chars
}

/** `handle`'s profile store and the profile budget in characters; 501 without a profile store, 404 for no such
 *  person. */
function open(ctx: RequestContext, handle: string, method: string): { store: MarkdownStore; maxChars: number } {
  const factory = ctx.office.profileStore
  if (factory === null) {
    throw new HttpError(501, "not_implemented", `${method} /profiles/${handle} is not implemented yet`)
  }
  const maxChars = maxCharsOf(withPerson(ctx, handle))
  return { store: factory(handle), maxChars }
}

/** The office's harness's profile-manager start; 501 when the harness runs no profile manager. */
function managerStart(ctx: RequestContext, handle: string): NonNullable<SessionHarness["startManager"]> {
  const harness = ctx.office.harness
  if (harness?.startManager === undefined) {
    throw new HttpError(501, "not_implemented", `POST /profiles/${handle}/manager is not implemented yet`)
  }
  return harness.startManager.bind(harness)
}

/** A 409 reply with both versions, for a write whose base version is no longer current. */
function conflict(error: MarkdownVersionMismatch): RawReply {
  const versions = VersionConflict.parse({ expected: error.expected, current: error.current })
  return new RawReply(409, {}, JSON.stringify(versions))
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
        return conflict(error)
      }
      const profile = Profile.parse({ person: handle, text, version, over_budget: overBudget(text, maxChars) })
      ctx.office.store.emit("profile.updated", handle, profile)
      return profile
    },
  },
  // Opens a profile-manager chat over a person's profile, opened by the verified person, with its first message.
  {
    method: "POST",
    path: "/profiles/:handle/manager",
    guard: (ctx, params) => {
      managerStart(ctx, params.handle!)
    },
    body: ProfileManagerRequest,
    reply: Session,
    handler: (ctx, params, body) => {
      const handle = params.handle!
      const { text } = body as ProfileManagerRequest
      const start = managerStart(ctx, handle)
      const by = actingPerson(ctx)
      return harnessCall(() => start(handle, text, { by }))
    },
  },
  // A person's profile proposals, oldest first.
  {
    method: "GET",
    path: "/profiles/:handle/proposals",
    reply: z.array(ProfileProposal),
    handler: (ctx, params) => {
      const handle = params.handle!
      withPerson(ctx, handle)
      return ctx.office.store.listProfileProposals(handle)
    },
  },
  // Applies an open proposal as the verified person; 409 with both versions if the profile changed since.
  {
    method: "POST",
    path: "/profile-proposals/:id/apply",
    reply: Profile,
    handler: async (ctx, params) => {
      const owner = actingPerson(ctx)
      const maxChars = maxCharsOf(loadRepo(ctx.office.git.root))
      try {
        return await applyProposal(ctx.office.store, ctx.office.git, params.id!, { owner, maxChars })
      } catch (error) {
        if (error instanceof ProposalNotFound) throw new HttpError(404, "not_found", error.message)
        if (error instanceof ProposalNotOpen) throw new HttpError(409, "not_open", error.message)
        if (error instanceof MarkdownVersionMismatch) return conflict(error)
        throw error
      }
    },
  },
]
