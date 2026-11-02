// `opencorp whoami`: who this device is, locally and to the office.
import { OfficeUnavailable } from "@opencorp/client"
import { identityPath } from "@opencorp/client/node"
import fs from "node:fs"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { localIdentity, officeClient, officeNotRunning } from "../office"

/** Whether nothing is at `file`. */
function absent(file: string): boolean {
  try {
    fs.lstatSync(file)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
  }
}

const USAGE = "usage: opencorp whoami"

/**
 * `opencorp whoami`: the handle and device in this device's identity, and who the office takes it to be. With no
 * identity file it says to log in; a file it can't use gets only the warning that says why.
 */
export const run: CommandRun = async (argv) => {
  try {
    if (parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" } } }).values.help) {
      console.log(USAGE)
      return 0
    }
  } catch (e) {
    console.error(`opencorp whoami: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const me = localIdentity()
  if (me) console.log(`This device: ${me.device}, as @${me.handle} (${identityPath()})`)
  else if (absent(identityPath())) console.log("This device has no identity; run `opencorp login`")
  try {
    const office = await officeClient(me).whoami()
    console.log(
      office.device
        ? `The office: @${office.person}, from device ${office.device}`
        : `The office: @${office.person}, the CEO (no human has a device yet, so it needs no token)`,
    )
    return 0
  } catch (e) {
    if (e instanceof OfficeUnavailable) return officeNotRunning()
    console.error(`opencorp whoami: ${e instanceof Error ? e.message : e}`)
    return 1
  }
}
