// `ac password`: sets a human's password, which `ac login` asks for on a new device.
import { OfficeUnavailable } from "@agent-corp/tui/office/errors"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { localIdentity, officeClient, officeNotRunning } from "../office"
import { prompter } from "../prompt"

/** The shortest password the office takes. */
const MIN_LENGTH = 8

/** How many times it asks before it stops. */
const TRIES = 3

/**
 * `ac password [--handle H]`: asks for a new password twice, without echo, and sets it as H's
 * (by default, whoever this device acts as). Only H or the CEO can. Needs a terminal.
 */
export const run: CommandRun = async (argv) => {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { handle: { type: "string" } } }))
  } catch (e) {
    console.error(`ac password: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const ask = prompter()
  if (!ask.interactive) {
    console.error("ac password: there's no terminal to read the password on without echo")
    return 2
  }
  const me = localIdentity()
  const office = officeClient(me)
  try {
    const handle = values.handle ?? me?.handle ?? (await office.whoami()).person
    for (let tries = 0; tries < TRIES; tries++) {
      const password = await ask.secret(`New password for @${handle} (at least ${MIN_LENGTH} characters; not shown)`)
      if (password.length < MIN_LENGTH) {
        console.error(`That doesn't work: use at least ${MIN_LENGTH} characters`)
        continue
      }
      if ((await ask.secret("Again")) !== password) {
        console.error("That doesn't work: the two passwords differ")
        continue
      }
      await office.people.setPassword(handle, { password })
      console.log(`Set @${handle}'s password.`)
      return 0
    }
    console.error("ac password: no usable password")
    return 1
  } catch (e) {
    if (e instanceof OfficeUnavailable) return officeNotRunning()
    console.error(`ac password: ${e instanceof Error ? e.message : e}`)
    return 1
  }
}
