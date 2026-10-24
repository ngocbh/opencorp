/** Who may add, remove or change the default of this office's model connections. */
import type { CompanyRepo } from "../company/loader.ts"
import { grants, subjects } from "./monitor.ts"

/** The grant, on an asset of kind `office`, that lets a person manage connections. */
export const TOOL = "connections"

/** Whether `person` may manage connections: the office's `owner` (the CEO while it has none), or someone granted
 *  `connections` or `admin` on an asset of kind `office`.
 *
 *  Advisory: anyone sharing the office's OS user can read its files. */
export function mayManageConnections(repo: CompanyRepo, person: string, { owner }: { owner: string | null }): boolean {
  // `||`, as Python's `or`: an empty owner is no owner.
  if (person === (owner || (repo.company?.ceo ?? null))) return true
  const covering = subjects(repo, person)
  return [...repo.assets.values()].some((a) => a.kind === "office" && grants(a, TOOL, covering).length > 0)
}
