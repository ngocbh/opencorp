/** An employee's permission for their harness, from their person: the session's folder writable or read-only and the
 *  network on or off as their `harness_policy` sets them, and the folders it lists, each mounted as listed. */
import fs from "node:fs"
import path from "node:path"
import type { HarnessPolicy } from "@opencorp/protocol"
import type { CompanyRepo } from "../../company/loader.ts"
import type { EmployeePermission } from "../../runtime/sandbox/harness_profile.ts"
import type { OfficePaths as SandboxOfficePaths } from "../../runtime/sandbox/policy.ts"

/** What a harness's start makes for one thread, beside the session's folder; the rest comes from the person. */
export type HarnessThread = Pick<EmployeePermission, "gitRoot" | "tmpdir" | "fence" | "harnessHomes">

/** The owner's home (where `~/` points), `<OPENCORP_HOME>`, and the guards every workspace stays clear of. */
export interface PermissionOffice {
  home: string
  officeHome: string
  guards: SandboxOfficePaths
}

/** The permission of `session`'s person in `repo` for one harness thread in the session's folder: read-only and
 *  offline when they have no `harness_policy` (or aren't in `repo`), and their folders as `listedFolders` gives them.
 *  Every other person's writable folders stay off the harness PATH. */
export function employeePermission(
  repo: Pick<CompanyRepo, "people">,
  session: { person: string; cwd: string },
  thread: HarnessThread,
  office: PermissionOffice,
  note: (line: string) => void,
): EmployeePermission {
  const policy = repo.people.get(session.person)?.harness_policy ?? null
  const othersWritable = [...repo.people]
    .filter(([handle]) => handle !== session.person)
    .flatMap(([, person]) => person.harness_policy?.folders ?? [])
    .filter((folder) => folder.access === "write")
    .map((folder) => inHome(folder.path, office.home))
    // One that isn't absolute names no folder that person's harness can write: their permission refuses it.
    .filter((p) => path.isAbsolute(p))
  return {
    workspace: session.cwd,
    ...thread,
    writable: policy?.sandbox === "workspace-write",
    network: policy?.network === true,
    folders: listedFolders(session.person, policy, office.home, note),
    home: office.home,
    officeHome: office.officeHome,
    office: office.guards,
    othersWritable: [...new Set(othersWritable)],
  }
}

/** `policy`'s folders as `handle`'s harness mounts them, in order and each with its access: `~/…` in `home`, and one
 *  that isn't a folder there (missing, a file, or one the office can't look at) left out, with a `note` saying so. A
 *  path that is neither absolute nor `~/…` is kept as written, so the permission's check refuses it, as lint reports
 *  it. None is left out for what it holds. */
function listedFolders(
  handle: string,
  policy: HarnessPolicy | null,
  home: string,
  note: (line: string) => void,
): EmployeePermission["folders"][number][] {
  const folders: EmployeePermission["folders"][number][] = []
  for (const folder of policy?.folders ?? []) {
    const p = inHome(folder.path, home)
    const missing = path.isAbsolute(p) ? notAFolder(p) : null
    if (missing !== null) {
      note(`@${handle}'s listed folder ${JSON.stringify(folder.path)} ${missing}, so their harness mounts nothing for it`)
      continue
    }
    folders.push({ path: p, access: folder.access })
  }
  return folders
}

/** `p` with a leading `~/` as `home`, joined as text: a `..` after it is resolved where a link points, as the OS
 *  resolves it, when the permission resolves the path. */
function inHome(p: string, home: string): string {
  if (!p.startsWith("~/")) return p
  return home.endsWith("/") ? home + p.slice(2) : `${home}/${p.slice(2)}`
}

/** Why `p` mounts nothing ("isn't there", "isn't a folder", or why the office can't look at it), or null for a folder
 *  (a link to one included). */
function notAFolder(p: string): string | null {
  try {
    return fs.statSync(p).isDirectory() ? null : "isn't a folder"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return "isn't there"
    return `can't be looked at (${code ?? (error as Error).name})`
  }
}
