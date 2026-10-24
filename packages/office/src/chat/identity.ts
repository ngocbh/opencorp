/** Who a person is and who they're talking with, as inputs their chat flows render into the reply's system prompt. */
import type { Person as PersonSchema } from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyRepo } from "../company/loader.ts"

type Person = z.output<typeof PersonSchema>

/** The `person` flow input: name, handle, title, company, and a sentence naming their manager.
 *
 *  `company` is `""` without a company. `reports_to` is `""` when the person has no manager or the manager isn't in
 *  the repo; flow templates have no conditionals, so the office hands them a whole sentence or nothing. */
export function personInputs(
  repo: CompanyRepo,
  person: Person,
): { name: string; handle: string; title: string; company: string; reports_to: string } {
  const manager = person.manager ? repo.people.get(person.manager) : undefined
  return {
    name: person.name,
    handle: person.handle,
    title: person.title,
    company: repo.company ? repo.company.name : "",
    reports_to: manager ? `You report to ${manager.name} (@${manager.handle}).` : "",
  }
}

/** The `talking_to` flow input: a sentence naming the human in the chat and how they relate to `person`.
 *
 *  The human is `openedBy`, or the CEO for a session that doesn't record who opened it. `""` when that human isn't in
 *  the repo or is `person`. The roles come from the org chart: the CEO, then one of your manager, your direct report,
 *  or your peer. */
export function talkingTo(repo: CompanyRepo, person: Person, openedBy: string | null | undefined): string {
  const ceo = repo.company ? repo.company.ceo : null
  const handle = openedBy || ceo
  const human = handle ? repo.people.get(handle) : undefined
  if (human === undefined || human.handle === person.handle) return ""
  const roles = human.handle === ceo ? ["the CEO"] : []
  if (person.manager === human.handle) roles.push("your manager")
  else if (human.manager === person.handle) roles.push("your direct report")
  else if (human.manager && human.manager === person.manager) roles.push("your peer")
  const said = roles.length > 0 ? `, ${roles.join(" and ")}` : ""
  return `You're talking with ${human.name} (@${human.handle})${said}.`
}
