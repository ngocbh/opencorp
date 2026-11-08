/** Profile routes: read and edit a person's profile (`memory/profile.md`) through the office's profile store, a
 *  FileMemory, and list and apply the profile manager's proposals. */
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
import { mayEditProfile } from "../../company/access.ts"
import { type CompanyRepo, loadRepo, missingPerson } from "../../company/loader.ts"
import { applyProposal, ProposalNotFound, ProposalNotOpen } from "../../profile/manager.ts"
import { type GitProfileStore, ProfileConflict, ProfileRefused, ProfileUnreadable } from "../../profile/store.ts"
import { newId } from "../../store/store.ts"
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

/** `handle`'s profile store, the profile budget in characters and the company repo; 501 without a profile store,
 *  404 for no such person. */
function open(
  ctx: RequestContext,
  handle: string,
  method: string,
): { store: GitProfileStore; maxChars: number; repo: CompanyRepo } {
  const factory = ctx.office.profileStore
  if (factory === null) {
    throw new HttpError(501, "not_implemented", `${method} /profiles/${handle} is not implemented yet`)
  }
  const repo = withPerson(ctx, handle)
  const maxChars = maxCharsOf(repo)
  return { store: factory(handle, maxChars), maxChars, repo }
}

/** 403 unless the acting person may change `handle`'s profile in `repo`: the CEO or one of their human managers. */
function checkProfileEdit(ctx: RequestContext, repo: CompanyRepo, handle: string): void {
  if (!mayEditProfile(repo, actingPerson(ctx), handle)) {
    const message = `only the CEO or @${handle}'s human managers can change @${handle}'s profile`
    throw new HttpError(403, "forbidden", message)
  }
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
function conflict(error: ProfileConflict): RawReply {
  const versions = VersionConflict.parse({ expected: error.expected, current: error.current })
  return new RawReply(409, {}, JSON.stringify(versions))
}

/** A 409 `unreadable_profile` for a profile that isn't one (not UTF-8, over the characters a profile may hold, a hard
 *  link, a symlink or not a regular file, or in a folder that is a symlink or not a folder), its message naming only
 *  the repo path; a 422 `refused` for text the memory refuses, with its reason. Rethrows any other error. */
// Only these classes: other RangeErrors from the store quote values.
function refused(error: unknown): never {
  if (error instanceof ProfileUnreadable) throw new HttpError(409, "unreadable_profile", error.message)
  if (error instanceof ProfileRefused) throw new HttpError(422, "refused", error.message)
  throw error
}

/** Whether `text` is longer than `maxChars`, counting code points as Python's `len` did. */
function overBudget(text: string, maxChars: number): boolean {
  return [...text].length > maxChars
}

/** The profile routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  // A person's profile text and version; 409 `unreadable_profile` for a profile that can't be read.
  {
    method: "GET",
    path: "/profiles/:handle",
    reply: Profile,
    handler: async (ctx, params): Promise<Profile> => {
      const handle = params.handle!
      const { store, maxChars } = open(ctx, handle, "GET")
      let read: { text: string; version: string }
      try {
        read = await store.read()
      } catch (error) {
        refused(error)
      }
      const { text, version } = read
      return { person: handle, text, version, over_budget: overBudget(text, maxChars) }
    },
  },
  // Replaces a profile if `base_version` is current, as the acting person; 409 with both versions if not, 409
  // `unreadable_profile` for a profile that can't be written, 422 `refused` for text over its cap.
  {
    method: "PUT",
    path: "/profiles/:handle",
    guard: (ctx, params) => {
      checkProfileEdit(ctx, open(ctx, params.handle!, "PUT").repo, params.handle!)
    },
    body: ProfileWriteRequest,
    reply: Profile,
    handler: async (ctx, params, body) => {
      const handle = params.handle!
      const { text, base_version } = body as ProfileWriteRequest
      // The guard's result can't reach the handler, and the load is cheap.
      const { store, maxChars, repo } = open(ctx, handle, "PUT")
      checkProfileEdit(ctx, repo, handle)
      // JSON can carry one, but UTF-8 can't; the store would refuse it as a 500.
      if (!text.isWellFormed()) throw new HttpError(422, "invalid_body", "text: holds a lone surrogate")
      const by = actingPerson(ctx)
      let version: string
      try {
        const written = await store.write(text, {
          baseVersion: base_version,
          // Each request is its own change.
          changeId: newId(),
          author: { kind: "user", name: by },
          // Named for who wrote it, so the commit isn't taken for a hand edit of the file.
          source: `${by} via profile edit`,
        })
        version = written.version
      } catch (error) {
        if (!(error instanceof ProfileConflict)) refused(error)
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
      checkProfileEdit(ctx, withPerson(ctx, params.handle!), params.handle!)
    },
    body: ProfileManagerRequest,
    reply: Session,
    handler: (ctx, params, body) => {
      const handle = params.handle!
      const { text } = body as ProfileManagerRequest
      const start = managerStart(ctx, handle)
      checkProfileEdit(ctx, withPerson(ctx, handle), handle)
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
  // Applies an open proposal as the verified person; 404 once its person is gone, 409 with both versions if the
  // profile changed since.
  {
    method: "POST",
    path: "/profile-proposals/:id/apply",
    guard: (ctx, params) => {
      const proposal = ctx.office.store.getProfileProposal(params.id!)
      if (proposal === undefined) throw new HttpError(404, "not_found", `no profile proposal ${params.id!}`)
      checkProfileEdit(ctx, loadRepo(ctx.office.git.root), proposal.person)
    },
    reply: Profile,
    handler: async (ctx, params) => {
      const owner = actingPerson(ctx)
      const proposal = ctx.office.store.getProfileProposal(params.id!)
      // An unknown id is applyProposal's 404. The person check is as racy as the other profile routes'.
      const repo = proposal ? withPerson(ctx, proposal.person) : loadRepo(ctx.office.git.root)
      const maxChars = maxCharsOf(repo)
      try {
        return await applyProposal(ctx.office.store, ctx.office.git, params.id!, { owner, maxChars })
      } catch (error) {
        if (error instanceof ProposalNotFound) throw new HttpError(404, "not_found", error.message)
        if (error instanceof ProposalNotOpen) throw new HttpError(409, "not_open", error.message)
        if (error instanceof ProfileConflict) return conflict(error)
        refused(error)
      }
    },
  },
]
