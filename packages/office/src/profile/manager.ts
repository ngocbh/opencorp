/** The profile manager: a chat that proposes edits to one person's profile, and applying a proposal. */
import { now, Profile } from "@opencorp/protocol"
import { structuredPatch } from "diff"
import type { CompanyGit } from "../company/git.ts"
import { InvalidTransition, newId, type ProfileProposalRecord, type SessionRecord, type Store } from "../store/store.ts"
import type { OfficeTool } from "../worker/rpc.ts"
import { GitProfileStore, ProfileConflict } from "./store.ts"

/** The profile manager's flow, relative to the session's pinned commit. */
export const MANAGER_FLOW = "shared/flows/profile_manager.yaml"

/** No profile proposal has the id. */
export class ProposalNotFound extends Error {
  override name = "ProposalNotFound"
}

/** The profile proposal is no longer open: applied, discarded, or stale. */
export class ProposalNotOpen extends Error {
  override name = "ProposalNotOpen"
}

/** A profile tool: an office tool whose call is async. */
export interface ProfileTool extends OfficeTool {
  readonly description: string
  readonly parameters: Record<string, unknown>
  call(args: Record<string, unknown>): Promise<unknown>
}

const READ = "Read the profile: its current text and version."
const PROPOSE_EDIT =
  "Propose the complete new text of the profile, as an edit of the version you read.\n\n" +
  "The owner reviews the diff and applies it."

/** Why `propose_edit` refuses an edit of a version that isn't the profile's: an old version can't be read, so the
 *  model reads the profile again. */
export const STALE_EDIT =
  "the profile changed since you read it; call profile_read again and propose an edit of the version it gives"

/** The `profile` tool group of a profile-manager session, which the model sees as `profile_read` and
 *  `profile_propose_edit`. `propose_edit` refuses text over 4 × the company's `profile_max_chars` code points, and an
 *  edit whose base version isn't the profile's (`STALE_EDIT`); it diffs against the current text. */
export function profileTools(
  store: Store,
  profile: GitProfileStore,
  session: SessionRecord,
): { read: ProfileTool; propose_edit: ProfileTool } {
  // Both schemas as the Python office's pydantic wrote them.
  return {
    read: {
      description: READ,
      parameters: { description: READ, properties: {}, title: "read", type: "object" },
      call: async () => {
        const { text, version } = await profile.read()
        return { text, version }
      },
    },
    propose_edit: {
      description: PROPOSE_EDIT,
      parameters: {
        description: PROPOSE_EDIT,
        properties: {
          text: { title: "Text", type: "string" },
          base_version: { title: "Base Version", type: "string" },
        },
        required: ["text", "base_version"],
        title: "propose_edit",
        type: "object",
      },
      call: async (args) => {
        const { text, base_version: baseVersion } = args
        if (typeof text !== "string" || typeof baseVersion !== "string") {
          throw new TypeError("text and base_version must be strings")
        }
        // The budget is soft, so applying over-budget text works; the cap only bounds what the model can store.
        const cap = profile.maxFileChars
        const n = [...text].length
        if (n > cap) {
          throw new RangeError(`text is ${n} characters; a proposal may hold at most ${cap} (4 × profile_max_chars)`)
        }
        if (!text.isWellFormed()) throw new RangeError("text holds a lone surrogate, which has no UTF-8 encoding")
        const { text: base, version } = await profile.read()
        if (version !== baseVersion) throw new Error(STALE_EDIT)
        const proposal = await propose(store, session, profile, baseVersion, base, text)
        return `Proposed edit ${proposal.id}. The owner can apply it from the profile view.`
      },
    },
  }
}

/** Store a proposal of `text` over `base`; the session's earlier open proposals are discarded. */
export function propose(
  store: Store,
  session: SessionRecord,
  profile: GitProfileStore,
  baseVersion: string,
  base: string,
  text: string,
): Promise<ProfileProposalRecord> {
  const diff = unifiedDiff(profile, base, text)
  // Waits for an apply in progress, which then isn't discarded under it.
  return serial(profile.git, () => {
    for (const older of store.listProfileProposals(profile.handle, { status: "open" })) {
      if (older.session_id !== session.id) continue
      try {
        store.setProfileProposalStatus(older.id, "discarded")
      } catch (error) {
        if (!(error instanceof InvalidTransition)) throw error // else applied meanwhile
      }
    }
    return store.addProfileProposal({
      id: newId(),
      session_id: session.id,
      person: profile.handle,
      base_version: baseVersion,
      text,
      diff,
      status: "open",
      commit: null,
      created_at: now(),
    })
  })
}

/**
 * Writes an open proposal over its base version as the owner, as the change `proposal-<id>`, and commits it as
 * `<owner> via profile manager`. Its change id makes a retry after a crash return the first write's version.
 *
 * Throws `ProposalNotFound` for an unknown proposal, `ProposalNotOpen` for one that isn't open, and `ProfileConflict`
 * when the profile has moved on (the proposal is then `stale`); the profile store's own errors pass through. Emits
 * `profile.updated`.
 */
export async function applyProposal(
  store: Store,
  git: CompanyGit,
  proposalId: string,
  { owner, maxChars }: { owner: string; maxChars: number },
): Promise<Profile> {
  // Held from the check to the status change, so a newer propose_edit can't discard the proposal after it is
  // committed. `git.locked` can't be held instead: the profile store's write takes it, and it isn't reentrant.
  const [proposal, version] = await serial(git, async () => {
    const proposal = store.getProfileProposal(proposalId)
    if (proposal === undefined) throw new ProposalNotFound(`no profile proposal ${proposalId}`)
    if (proposal.status !== "open") throw new ProposalNotOpen(`profile proposal ${proposalId} is ${proposal.status}`)
    const profile = new GitProfileStore(git, proposal.person, { maxChars })
    let written: { version: string; commit: string | null }
    try {
      written = await profile.write(proposal.text, {
        baseVersion: proposal.base_version,
        changeId: `proposal-${proposal.id}`,
        author: { kind: "user", name: owner },
        source: `${owner} via profile manager`,
      })
    } catch (error) {
      if (error instanceof ProfileConflict) store.setProfileProposalStatus(proposal.id, "stale")
      throw error
    }
    // A proposal of the text as it was commits nothing; its commit is then the current one. One whose commit failed
    // waits for the hand-edit sweep; head is close enough.
    const { version } = written
    store.setProfileProposalStatus(proposal.id, "applied", { commit: written.commit ?? (await git.head()) })
    return [proposal, version] as const
  })
  const applied = Profile.parse({
    person: proposal.person,
    text: proposal.text,
    version,
    over_budget: [...proposal.text].length > maxChars, // code points, as Python's len
  })
  store.emit("profile.updated", proposal.person, applied)
  return applied
}

/** The tail of each company repo's queue of proposal changes. */
const queues = new WeakMap<CompanyGit, Promise<unknown>>()

/** Runs `fn` once every earlier `serial` call on `git` has settled. */
function serial<T>(git: CompanyGit, fn: () => T | Promise<T>): Promise<T> {
  const run = (queues.get(git) ?? Promise.resolve()).then(fn)
  queues.set(git, run.catch(() => {}))
  return run
}

/** A hunk header's range from 1-based line `start`, `length` lines long, as difflib writes it. */
function range(start: number, length: number): string {
  if (length === 1) return `${start}`
  return `${length ? start : start - 1},${length}`
}

/** The unified diff of `profile` from `base` to `text`, with difflib's headers and hunk ranges. Its hunks can pair
 *  lines differently from difflib's on ambiguous edits (reordered blocks, repeated lines), and only `\n` ends a
 *  line. Past 1000 changed lines or 200 ms, one hunk replaces the whole file. */
function unifiedDiff(profile: GitProfileStore, base: string, text: string): string {
  // The diff runs on the event loop and its worst case grows with the square of the text, so it is bounded; the
  // diff is only shown, so a coarser one is fine.
  const patch = structuredPatch(`a/${profile.path}`, `b/${profile.path}`, base, text, undefined, undefined, {
    context: 3,
    maxEditLength: 1000,
    timeout: 200,
  })
  if (patch === undefined) return wholeFileHunk(profile, base, text)
  if (patch.hunks.length === 0) return ""
  let out = `--- a/${profile.path}\n+++ b/${profile.path}\n`
  for (const hunk of patch.hunks) {
    out += `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@\n`
    hunk.lines.forEach((line, k) => {
      // A "\\ No newline at end of file" marker follows a last line without its end, which difflib writes as it is.
      if (!line.startsWith("\\")) out += hunk.lines[k + 1]?.startsWith("\\") ? line : `${line}\n`
    })
  }
  return out
}

/** One hunk that removes every line of `base` and adds every line of `text`, with difflib's headers; a last line
 *  without its end is written as it is. */
function wholeFileHunk(profile: GitProfileStore, base: string, text: string): string {
  const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const old = lines(base)
  const neu = lines(text)
  let out = `--- a/${profile.path}\n+++ b/${profile.path}\n`
  out += `@@ -${range(1, old.length)} +${range(1, neu.length)} @@\n`
  for (const line of old) out += `-${line}`
  for (const line of neu) out += `+${line}`
  return out
}
