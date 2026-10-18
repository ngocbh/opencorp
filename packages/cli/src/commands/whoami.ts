// `ac whoami`: who this device is, locally and to the office.
import { OfficeUnavailable } from "@opencorp/tui/office/errors"
import { identityPath } from "@opencorp/tui/office/paths"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { localIdentity, officeClient, officeNotRunning } from "../office"

/** `ac whoami`: the handle and device in this device's identity, and who the office takes it to be. */
export const run: CommandRun = async (argv) => {
  try {
    parseArgs({ args: argv, options: {} })
  } catch (e) {
    console.error(`ac whoami: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const me = localIdentity()
  console.log(
    me
      ? `This device: ${me.device}, as @${me.handle} (${identityPath()})`
      : "This device has no identity; run `ac login`",
  )
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
    console.error(`ac whoami: ${e instanceof Error ? e.message : e}`)
    return 1
  }
}
