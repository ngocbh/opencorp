/** Who may change a person's profile or hire under a manager, and the commit line that names who did. */
import { Handle } from "@opencorp/protocol"
import type { CompanyRepo } from "./loader.ts"

/** Whether `actor` is a human on the manager chain that starts at `start` (`start` itself included). */
export function inManagerChain(repo: CompanyRepo, actor: string, start: string | null): boolean {
  // Lint reports a manager cycle but doesn't stop one reaching the working tree, so the walk remembers where it went.
  const seen = new Set<string>()
  for (let handle = start; handle !== null && !seen.has(handle); ) {
    seen.add(handle)
    const found = repo.people.get(handle)
    if (found === undefined) return false
    if (handle === actor) return found.kind === "human"
    handle = found.manager
  }
  return false
}

/** Whether `actor` may change `handle`'s profile: the CEO always, otherwise a human on the person's manager chain. */
export function mayEditProfile(repo: CompanyRepo, actor: string, handle: string): boolean {
  if (actor === repo.company?.ceo) return true
  const target = repo.people.get(handle)
  return target !== undefined && inManagerChain(repo, actor, target.manager)
}

/** Whether `actor` may hire someone reporting to `manager`, which writes the new hire's profile: the CEO, or a
 *  human who would have profile access to them (`manager` or a human above them). */
export function mayHireUnder(repo: CompanyRepo, actor: string, manager: string): boolean {
  return actor === repo.company?.ceo || inManagerChain(repo, actor, manager)
}

/** The commit-message body line naming `actor`, blank line first. A RangeError if `actor` isn't a handle, so the
 *  line can't carry a trailer of its own. */
export function actorLine(actor: string): string {
  if (!Handle.safeParse(actor).success) throw new RangeError("actor is not a handle")
  return `\n\nActor: @${actor}`
}
