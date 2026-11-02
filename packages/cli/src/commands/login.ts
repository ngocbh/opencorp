// `opencorp login`: gives this device its own token and asks the office to list it for a person.
import type { Person } from "@opencorp/protocol"
import { createOfficeClient, OfficeError, UnknownDevice } from "@opencorp/client"
import {
  DEVICE_NAME,
  deviceName,
  newToken,
  tokenSha256,
  writeIdentity,
  defaultSocket,
  identityPath,
} from "@opencorp/client/node"
import fs from "node:fs"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { bareHandle, localIdentity, officeAnswers, officeNotRunning } from "../office"
import { prompter } from "../prompt"

/** The company's CEO among `people`: the human with no manager. */
export const ceoOf = (people: Person[]) => people.find((p) => p.kind === "human" && !p.manager)?.handle

const USAGE = "usage: opencorp login [--handle H] [--device NAME] [--force]"

/** How many passwords `opencorp login` tries before it stops. */
const TRIES = 3

// The shape `newToken` makes; the office refuses any other.
const TOKEN = /^act_[A-Za-z0-9_-]{43}$/

/**
 * `opencorp login [--handle H] [--device NAME] [--force]`: makes a token, writes this device's identity,
 * then adds the device to H's devices. The device defaults to this host's short name. On a
 * terminal, it asks for H (the CEO by default) and H's password, which lets the office add the
 * device from anywhere; otherwise H defaults to the CEO. Without a password, or for a human with
 * none, it asks the office to add the device as this device: when that's refused, prints the
 * `opencorp devices add` to run on a device it trusts. A device the office already knows asks nothing. A saved
 * identity the office doesn't list yet gets its `opencorp devices add` line printed again, for the same token;
 * `--force` replaces it with a new token.
 */
export const run: CommandRun = async (argv) => {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        handle: { type: "string" },
        device: { type: "string" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }))
  } catch (e) {
    console.error(`opencorp login: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const file = identityPath()
  const device = values.device ?? deviceName()
  if (!DEVICE_NAME.test(device)) {
    console.error("opencorp login: --device takes lowercase letters, digits, '.', '_' and '-', starting with a letter or digit")
    return 2
  }
  const socket = defaultSocket()
  // Checked before anything is written, so no office leaves no half-made identity.
  if (!(await officeAnswers(socket))) return officeNotRunning()
  const known = fs.existsSync(file) ? localIdentity() : undefined
  if (fs.existsSync(file) && !values.force) {
    const me = known && (await whoIs(socket, known.token))
    if (known && me?.person === known.handle && me.device === known.device) {
      console.log(`This device is already logged in: ${known.device}, acting as @${known.handle} (${file}).`)
      return 0
    }
    // The flags may only repeat what the file says; naming another person or device means a new token.
    const asSaved = (flag: string | undefined, saved: string) => flag === undefined || flag === saved
    if (
      known &&
      !me &&
      asSaved(values.handle, known.handle) &&
      asSaved(values.device, known.device) &&
      TOKEN.test(known.token) &&
      DEVICE_NAME.test(known.device)
    ) {
      // Nothing is sent: a password or an open office would list again a token that was removed on purpose. The
      // line needs someone on a trusted device, and its hash is no secret to anyone who can read the file.
      vouch(known.handle, known.device, tokenSha256(known.token))
      console.error("To start over with a new token instead, pass --force; the line above then stops working.")
      return 1
    }
    if (known && me) {
      console.error(
        `opencorp login: the office takes this device's token (${file}) as @${me.person}'s ${me.device}, not @${known.handle}'s ${known.device}; pass --force to replace it`,
      )
      return 1
    }
    console.error(
      `opencorp login: this device already has an identity (${file}) that login can't pick up; pass --force to replace it`,
    )
    return 1
  }
  // The identity being replaced may still be trusted, which lets the office take the new device
  // even once it requires a token.
  const office = createOfficeClient({ socket, token: values.force ? known?.token : undefined })
  // The device being replaced, as the office lists it, so it can be removed once the new one is listed.
  const old = values.force && known ? await listedAs(socket, known.token) : null
  const ask = prompter()
  let handle = values.handle === undefined ? undefined : bareHandle(values.handle)
  if (handle === undefined) {
    let ceo: string | undefined
    try {
      ceo = ceoOf(await office.people.list())
    } catch (e) {
      if (!(e instanceof UnknownDevice)) return failed(e)
    }
    handle = ask.interactive ? bareHandle(await ask.ask("Your handle", ceo)) || undefined : ceo
    if (handle === undefined) {
      console.error("opencorp login: the office won't list its people to this device; pass --handle")
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
      console.error(`opencorp login: couldn't write ${file}: ${e instanceof Error ? e.message : e}`)
      return false
    }
  }
  const loggedIn = async () => {
    if (!save()) return 1
    console.log(`This device is ${device}, acting as @${handle}; its token is in ${file}.`)
    if (old) await removeReplaced(socket, known!.token, old)
    return 0
  }
  let password = ask.interactive ? await ask.secret(`@${handle}'s password (not shown; empty if you have none)`) : ""
  for (let tries = 1; password; tries++) {
    try {
      await office.login({ handle, password, device, token_sha256: hash })
      return loggedIn()
    } catch (e) {
      if (e instanceof OfficeError && e.code === "no_password") {
        console.error(`@${handle} has no password yet; set one with \`opencorp password\``)
        break
      }
      if (!(e instanceof OfficeError && e.code === "bad_login")) return refused(e, handle, device)
    }
    if (tries === TRIES) {
      console.error(`opencorp login: no password worked for @${handle}`)
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
      vouch(handle, device, hash)
      // Not removed: until the new device is listed, the old one may be the office's last, whose removal opens the
      // office to requests without a token.
      if (old) console.error(remains(old))
      return 1
    }
    return refused(e, handle, device)
  }
  return loggedIn()
}

/** A device the office lists: its person's handle and its name. */
type Listed = { person: string; device: string }

/** The person and device the office takes `token` to be, or null when it doesn't know the token or can't say. */
async function listedAs(socket: string, token: string): Promise<Listed | null> {
  try {
    const me = await createOfficeClient({ socket, token }).whoami()
    return me.device === null ? null : { person: me.person, device: me.device }
  } catch (e) {
    // Only the cleanup after the login needs it, so the login goes on without it.
    if (e instanceof OfficeError) return null
    throw e
  }
}

/** What to say when the replaced device `old` is still listed. */
const remains = (old: Listed) =>
  `${old.device} in people/${old.person}/person.yaml remains; remove it with \`opencorp devices remove ${old.person} ${old.device}\``

/** Removes `old`, the device a `--force` login replaced, with its own token, which may always remove it, and says
 *  so; a removal that fails leaves the login done and says the entry remains. */
async function removeReplaced(socket: string, token: string, old: Listed): Promise<void> {
  try {
    await createOfficeClient({ socket, token }).devices.remove(old.person, old.device)
    console.log(`Removed ${old.device} from people/${old.person}/person.yaml.`)
  } catch (e) {
    // Already gone: the office no longer lists the token or the device.
    if (e instanceof UnknownDevice || (e instanceof OfficeError && e.code === "not_found")) return
    console.error(remains(old))
  }
}

/** Who the office takes `token` to be, or undefined when it doesn't know the token. */
async function whoIs(socket: string, token: string): Promise<{ person: string; device: string | null } | undefined> {
  try {
    return await createOfficeClient({ socket, token }).whoami()
  } catch (e) {
    if (e instanceof UnknownDevice) return undefined
    throw e
  }
}

/** Says to run `opencorp devices add` for `device` of `handle`, with token sha256 `hash`, on a trusted device. */
function vouch(handle: string, device: string, hash: string) {
  console.error(`opencorp login: the office doesn't trust this device yet. On a device it trusts, run:`)
  console.error(`  opencorp devices add ${handle} ${device} ${hash}`)
}

function refused(e: unknown, handle: string, device: string) {
  if (e instanceof OfficeError && e.code === "device_exists") {
    console.error(
      `opencorp login: @${handle} already has a device named ${device}; remove it (\`opencorp devices remove ${handle} ${device}\`) or pick another --device`,
    )
    return 1
  }
  return failed(e)
}

function failed(e: unknown) {
  console.error(`opencorp login: ${e instanceof Error ? e.message : e}`)
  return 1
}
