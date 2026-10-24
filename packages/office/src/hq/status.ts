/** Who else uses this host: on such a host, whoever holds HQ's TCP port while the office doesn't is the origin the
 *  browser trusts. */
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const NOT_PEOPLE = new Set(["Shared", "Guest"])

/** This user's name, in Python's `getpass.getuser()` order: `LOGNAME`, `USER`, `LNAME`, `USERNAME`, then the
 *  account's name ("" when none is found). */
export function currentUser(): string {
  for (const name of ["LOGNAME", "USER", "LNAME", "USERNAME"]) {
    const value = process.env[name]
    if (value) return value
  }
  try {
    return os.userInfo().username
  } catch {
    return ""
  }
}

/** The output of `who`; "" when it fails or takes over 2 s. */
export async function runWho(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/who", [], { timeout: 2000, env: { LC_ALL: "C" } })
    return stdout
  } catch {
    return ""
  }
}

/** `p` is a directory, following a symlink; false when it can't be checked. */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Other accounts, sorted: on macOS, the folders under `usersDir`; elsewhere, the users `who` lists now. */
export async function otherUsers(
  platform: string = process.platform,
  {
    usersDir = "/Users",
    me = currentUser(),
    who = runWho,
  }: { usersDir?: string; me?: string; who?: () => Promise<string> } = {},
): Promise<string[]> {
  const others = (names: string[]): string[] => [...new Set(names)].filter((name) => name !== me).sort()
  if (platform !== "darwin") {
    return others(
      (await who())
        .split("\n")
        .map((line) => line.trim().split(/\s+/u)[0])
        .filter((name): name is string => Boolean(name)),
    )
  }
  try {
    return others(
      fs
        .readdirSync(usersDir)
        .filter((name) => !name.startsWith(".") && !NOT_PEOPLE.has(name) && isDir(path.join(usersDir, name))),
    )
  } catch {
    return []
  }
}
