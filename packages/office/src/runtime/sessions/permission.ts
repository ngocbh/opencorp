/** An employee's permission for their harness, from their person: the session's folder writable or read-only and the
 *  network on or off as their `harness_policy` sets them, the folders it lists, each mounted as listed, and the owner's
 *  MCP servers it allows. */
import fs from "node:fs"
import path from "node:path"
import type { HarnessPolicy } from "@opencorp/protocol"
import type { CompanyRepo } from "../../company/loader.ts"
import { MCP_SERVER_NAME } from "../../company/naming.ts"
import type { EmployeePermission } from "../sandbox/harness_profile.ts"
import type { OfficePaths as SandboxOfficePaths } from "../sandbox/policy.ts"

/** What a harness's start makes for one thread, beside the session's folder; the rest comes from the person. */
export type HarnessThread = Pick<EmployeePermission, "gitRoot" | "tmpdir" | "fence" | "harnessHomes">

/** The owner's home (where `~/` points), `<OPENCORP_HOME>`, and the guards every workspace stays clear of. */
export interface PermissionOffice {
  home: string
  officeHome: string
  guards: SandboxOfficePaths
}

/** What else others may write, beside other people's writable folders in the session's own commit: the company at
 *  other commits the office runs (its head), and the folders of live sessions. */
export interface Others {
  repos?: readonly Pick<CompanyRepo, "people">[]
  workspaces?: readonly string[]
}

/** The permission of `session`'s person in `repo` for one harness thread in the session's folder: read-only, offline
 *  and with no MCP server when they have no `harness_policy` (or aren't in `repo`), their folders as `listedFolders`
 *  gives them, and each plain MCP server name it allows, once.
 *  What others may write stays off the harness PATH: every other person's writable folders in `repo`, everyone's in
 *  `others.repos` (this person's too, since a session of theirs started there may write them), and
 *  `others.workspaces`. */
export function employeePermission(
  repo: Pick<CompanyRepo, "people">,
  session: { person: string; cwd: string },
  thread: HarnessThread,
  office: PermissionOffice,
  note: (line: string) => void,
  others: Others = {},
): EmployeePermission {
  const policy = repo.people.get(session.person)?.harness_policy ?? null
  const people = [
    ...[...repo.people].filter(([handle]) => handle !== session.person),
    ...(others.repos ?? []).flatMap((other) => [...other.people]),
  ]
  const othersWritable = people
    .flatMap(([, person]) => person.harness_policy?.folders ?? [])
    .filter((folder) => folder.access === "write")
    .map((folder) => inHome(folder.path, office.home))
    // One that isn't absolute names no folder that person's harness can write: their permission refuses it.
    .filter((p) => path.isAbsolute(p) && !p.includes("\0"))
  return {
    workspace: session.cwd,
    ...thread,
    writable: policy?.sandbox === "workspace-write",
    network: policy?.network === true,
    folders: listedFolders(session.person, policy, office.home, note),
    home: office.home,
    officeHome: office.officeHome,
    office: office.guards,
    othersWritable: [...new Set([...othersWritable, ...(others.workspaces ?? [])])],
    // A name that isn't plain allows nothing, as lint reports it.
    allowedMcp: [...new Set((policy?.mcp_servers ?? []).filter((name) => MCP_SERVER_NAME.test(name)))],
  }
}

/** Every writable folder the people in `repo` list, `~/…` in `home`, as each person's harness may write them: what
 *  no harness may run a program from. One that isn't absolute, or holds a null byte, names nothing. */
export function writableFolders(repo: Pick<CompanyRepo, "people">, home: string): string[] {
  const all = [...repo.people.values()]
    .flatMap((person) => person.harness_policy?.folders ?? [])
    .filter((folder) => folder.access === "write")
    .map((folder) => inHome(folder.path, home))
    .filter((p) => path.isAbsolute(p) && !p.includes("\0"))
  return [...new Set(all)]
}

/** `policy`'s folders as `handle`'s harness mounts them, in order and each with its access: `~/…` in `home`, and one
 *  that isn't a folder there (missing, a file, or one the office can't look at) left out, with a `note` saying so. A
 *  path that is neither absolute nor `~/…`, or holds a null byte, is kept as written, so the permission's check
 *  refuses it, as lint reports it. None is left out for what it holds. */
function listedFolders(
  handle: string,
  policy: HarnessPolicy | null,
  home: string,
  note: (line: string) => void,
): EmployeePermission["folders"][number][] {
  const folders: EmployeePermission["folders"][number][] = []
  for (const folder of policy?.folders ?? []) {
    const p = inHome(folder.path, home)
    const missing = path.isAbsolute(p) && !p.includes("\0") ? notAFolder(p) : null
    if (missing !== null) {
      const shown = JSON.stringify(folder.path)
      note(`@${handle}'s listed folder ${shown} ${missing}, so their harness mounts nothing for it`)
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
