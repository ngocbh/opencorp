// `ac login`: gives this device its own token and asks the office to list it for a person.
import type { Person } from "@agent-corp/protocol"
import { createOfficeClient } from "@agent-corp/tui/office/client"
import { OfficeError, UnknownDevice } from "@agent-corp/tui/office/errors"
import { DEVICE_NAME, deviceName, newToken, tokenSha256, writeIdentity } from "@agent-corp/tui/office/identity"
import { defaultSocket, identityPath } from "@agent-corp/tui/office/paths"
import fs from "node:fs"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { localIdentity, officeAnswers, officeNotRunning } from "../office"
import { prompter } from "../prompt"

/** The company's CEO among `people`: the human with no manager. */
export const ceoOf = (people: Person[]) => people.find((p) => p.kind === "human" && !p.manager)?.handle

/** How many passwords `ac login` tries before it stops. */
const TRIES = 3

/**
 * `ac login [--handle H] [--device NAME] [--force]`: makes a token, writes this device's identity,
 * then adds the device to H's devices. The device defaults to this host's short name. On a
 * terminal, it asks for H (the CEO by default) and H's password, which lets the office add the
 * device from anywhere; otherwise H defaults to the CEO. Without a password, or for a human with
 * none, it asks the office to add the device as this device: when that's refused, prints the
 * `ac devices add` to run on a device it trusts. A device the office already knows asks nothing.
 */
export const run: CommandRun = async (argv) => {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: { handle: { type: "string" }, device: { type: "string" }, force: { type: "boolean" } },
    }))
  } catch (e) {
    console.error(`ac login: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const file = identityPath()
  const device = values.device ?? deviceName()
  if (!DEVICE_NAME.test(device)) {
    console.error("ac login: --device takes lowercase letters, digits, '.', '_' and '-', starting with a letter or digit")
    return 2
  }
  const socket = defaultSocket()
  // Checked before anything is written, so no office leaves no half-made identity.
  if (!(await officeAnswers(socket))) return officeNotRunning()
  const known = fs.existsSync(file) ? localIdentity() : undefined
  if (fs.existsSync(file) && !values.force) {
    if (known && (await knows(socket, known.token, known.handle, known.device))) {
      console.log(`This device is already logged in: ${known.device}, acting as @${known.handle} (${file}).`)
      return 0
    }
    console.error(
      `ac login: this device already has an identity (${file}) the office doesn't know yet; pass --force to replace it`,
    )
    return 1
  }
  // The identity being replaced may still be trusted, which lets the office take the new device
  // even once it requires a token.
  const office = createOfficeClient({ socket, token: values.force ? known?.token : undefined })
  const ask = prompter()
  let handle = values.handle
  if (handle === undefined) {
    let ceo: string | undefined
    try {
      ceo = ceoOf(await office.people.list())
    } catch (e) {
      if (!(e instanceof UnknownDevice)) return failed(e)
    }
    handle = ask.interactive ? (await ask.ask("Your handle", ceo)).replace(/^@/, "") || undefined : ceo
    if (handle === undefined) {
      console.error("ac login: the office won't list its people to this device; pass --handle")
      return 2
    }
  }
  const token = newToken()
  const hash = tokenSha256(token)
  // The identity is written only once the office takes the device or says to vouch for it from
  // a trusted one, so a refused `--force` keeps the identity it would have replaced.
  const save = () => {
    try {
      writeIdentity(file, { handle, device, token })
      return true
    } catch (e) {
      console.error(`ac login: couldn't write ${file}: ${e instanceof Error ? e.message : e}`)
      return false
    }
  }
  const loggedIn = () => {
    if (!save()) return 1
    console.log(`This device is ${device}, acting as @${handle}; its token is in ${file}.`)
    return 0
  }
  let password = ask.interactive ? await ask.secret(`@${handle}'s password (not shown; empty if you have none)`) : ""
  for (let tries = 1; password; tries++) {
    try {
      await office.login({ handle, password, device, token_sha256: hash })
      return loggedIn()
    } catch (e) {
      if (e instanceof OfficeError && e.code === "no_password") {
        console.error(`@${handle} has no password yet; set one with \`ac password\``)
        break
      }
      if (!(e instanceof OfficeError && e.code === "bad_login")) return refused(e, handle, device)
    }
    if (tries === TRIES) {
      console.error(`ac login: no password worked for @${handle}`)
      return 1
    }
    console.error("That doesn't work: wrong handle or password")
    password = await ask.secret(`@${handle}'s password (not shown; empty if you have none)`)
  }
  try {
    await office.devices.add(handle, { name: device, token_sha256: hash })
  } catch (e) {
    if (e instanceof OfficeError && (e.status === 401 || e.status === 403)) {
      if (!save()) return 1
      console.error(`ac login: the office doesn't trust this device yet. On a device it trusts, run:`)
      console.error(`  ac devices add ${handle} ${device} ${hash}`)
      return 1
    }
    return refused(e, handle, device)
  }
  return loggedIn()
}

/** Whether the office takes `token` to be `device` of `handle`. */
async function knows(socket: string, token: string, handle: string, device: string) {
  try {
    const me = await createOfficeClient({ socket, token }).whoami()
    return me.person === handle && me.device === device
  } catch (e) {
    if (e instanceof UnknownDevice) return false
    throw e
  }
}

function refused(e: unknown, handle: string, device: string) {
  if (e instanceof OfficeError && e.code === "device_exists") {
    console.error(
      `ac login: @${handle} already has a device named ${device}; remove it (\`ac devices remove ${handle} ${device}\`) or pick another --device`,
    )
    return 1
  }
  return failed(e)
}

function failed(e: unknown) {
  console.error(`ac login: ${e instanceof Error ? e.message : e}`)
  return 1
}
