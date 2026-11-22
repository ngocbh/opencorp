/** The checks of a session's folder, for every harness's sessions: an absolute path to a folder the office can
 *  open, which the workspace check takes and which keeps clear of the office's own files. */
import fs from "node:fs"
import path from "node:path"
import type { OfficePaths } from "../../util/home.ts"
import {
  type OfficePaths as SandboxOfficePaths,
  UnsafeWorkspace,
  checkClearOf,
  checkWorkspace,
  realPath,
} from "../sandbox/policy.ts"
import { HarnessError } from "./state.ts"

/** What the session-folder checks use of the office: the guards and the office's own paths. */
export interface FolderOffice {
  readonly guards: SandboxOfficePaths
  readonly paths: OfficePaths
}

/** The realpath of `cwd`, a new session's folder, once it is checked: 422 `invalid_body` when it isn't an absolute path
 *  to a folder, is too long for the system to name, or can't be opened by the office, and 422 `unsafe_workspace`
 *  (`log` gets why) when `checkWorkspace` refuses it or it overlaps the office's own files. */
export function checkFolder(office: FolderOffice, cwd: string, log: (line: string) => void): string {
  const real = folderOf(cwd)
  try {
    checkWorkspace(real, office.guards)
  } catch (error) {
    if (error instanceof UnsafeWorkspace) throw unsafeWorkspace(error, log)
    throw error
  }
  checkOverlap(office, real, log)
  return real
}

/** The realpath of `cwd`: 422 `invalid_body` when it isn't an absolute path to a folder, is too long for the system to
 *  name, or can't be opened by the office. */
export function folderOf(cwd: string): string {
  // A 422 never echoes the request's path: it may not be a folder at all.
  if (!path.isAbsolute(cwd)) throw new HarnessError(422, "invalid_body", "cwd is not an absolute path")
  const problem = folderProblem(cwd)
  if (problem !== null) throw new HarnessError(422, "invalid_body", problem)
  // Clients match folders by their resolved path (/tmp is /private/tmp on macOS).
  return realPath(cwd)
}

/** 422 `unsafe_workspace` (`log` gets why) when `real`, a resolved folder, overlaps the office's own files. */
export function checkOverlap(office: FolderOffice, real: string, log: (line: string) => void): void {
  try {
    // The workspace check guards ~/.opencorp; this office's home may be elsewhere.
    checkClearOf(real, [office.paths.company, office.paths.office])
  } catch (error) {
    if (error instanceof UnsafeWorkspace) throw unsafeWorkspace(error, log)
    throw error
  }
}

/** The 422 `unsafe_workspace` for the refusal `refused`: the reply gets its reason, and `log` its message, which names
 *  paths; a 422 names the field, not its value. */
export function unsafeWorkspace(refused: UnsafeWorkspace, log: (line: string) => void): HarnessError {
  // Quoted, so a folder name with a newline can't add a line to the log.
  log(`a session folder was refused: ${JSON.stringify(refused.message)}`)
  return new HarnessError(
    422,
    "unsafe_workspace",
    `cwd can't be a workspace: ${refused.reason} (the office log has the paths)`,
  )
}

/** Why `p` can't be a session's folder, or null when it is a folder: it isn't one (missing, a file, below a file, a
 *  link loop, a NUL byte), it is too long to name, or the office may not reach it. Any other error is thrown. */
function folderProblem(p: string): string | null {
  try {
    return fs.statSync(p).isDirectory() ? null : "cwd is not a folder"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ""
    if (["ENOENT", "ENOTDIR", "ELOOP", "EBADF", "ERR_INVALID_ARG_VALUE"].includes(code)) return "cwd is not a folder"
    if (code === "ENAMETOOLONG") return "cwd is too long for this system"
    if (code === "EACCES" || code === "EPERM") return "cwd can't be opened by the office"
    // Such as EIO or EMFILE: trouble on the office's side, not in the request.
    throw error
  }
}
