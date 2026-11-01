/** A real office whose owner registered this device at onboarding: `opencorp` and the TUI's client use its token,
 *  and nothing else gets in. */
import path from "node:path"
import { readIdentity, tokenSha256 } from "@opencorp/client/node"
import { expect, test } from "bun:test"
import { git } from "../company/helpers.ts"
import { folder, openOffice, REPO, type RunningOffice, run } from "./helpers.ts"

const TIMEOUT = 180_000

const TUI_CLIENT = `
import { createOfficeClient } from "./packages/client/src/client"
import { readIdentity } from "./packages/client/src/identity"
import { defaultSocket, identityPath } from "./packages/client/src/paths"

const me = readIdentity(identityPath())
const client = createOfficeClient({ socket: defaultSocket(), token: me?.token })
const seen = { whoami: await client.whoami(), people: (await client.people.list()).map((p) => p.handle) }
const stream = await new Promise((resolve) => {
  const sub = client.events.subscribe((e) => {
    if (e.type === "connected" || e.type === "unreachable") {
      sub.close()
      resolve(e.type === "connected" ? "connected" : String(e.error))
    }
  }, { minDelayMs: 50 })
})
console.log(JSON.stringify({ ...seen, stream }))
`

/** What the TUI's office client reads from `office` as this device: who it is, the people, the stream. */
async function tuiClient(office: RunningOffice): Promise<unknown> {
  const done = await run([process.execPath, "-e", TUI_CLIENT], { cwd: REPO, env: office.env, timeout: 60_000 })
  if (done.code !== 0) throw new Error(done.stdout + done.stderr)
  return JSON.parse(done.stdout)
}

test(
  "opencorp and the tui use the device token and nothing else gets in",
  async () => {
    const owned = await openOffice({ device: true })
    const workspace = folder(path.join(owned.root, "project"))
    const me = readIdentity(path.join(owned.home, "identity.json"))!
    const outputs: string[] = []
    const opencorp = async (argv: string[]) => {
      const done = await owned.opencorp(argv, { cwd: workspace })
      outputs.push(done.stdout, done.stderr)
      return done
    }

    // The first commit already lists the device, by its token's hash.
    const root = git(owned.paths.company, "rev-list", "--max-parents=0", "HEAD")
    const first = git(owned.paths.company, "show", `${root}:people/ngocbh/person.yaml`)
    expect(first).toContain(me.device)
    expect(first).toContain(tokenSha256(me.token))
    const whoami = (await opencorp(["whoami"])).stdout
    expect(whoami).toContain(`The office: @ngocbh, from device ${me.device}`)

    // Without the token: only the liveness probe answers.
    expect(await (await owned.request("GET", "/health", { anonymous: true })).json()).toEqual({ ok: true })
    const refused = await owned.request("GET", "/people", { anonymous: true })
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([401, "unauthenticated"])
    const events = await owned.request("GET", "/events", { anonymous: true })
    expect(events.status).toBe(401)
    await events.body?.cancel()

    // The TUI's client: requests and the event stream, with the token from identity.json.
    expect(await tuiClient(owned)).toEqual({
      whoami: { person: "ngocbh", device: me.device },
      people: ["minh", "ngocbh"],
      stream: "connected",
    })

    // `opencorp` commands: a session ends, and the device list shows names only.
    owned.llm.script({ content: "Hi." })
    const sid = await owned.startChat(await owned.person("minh"), workspace)
    await opencorp(["end", sid])
    expect(["ending", "ended"]).toContain(await owned.status(sid))
    expect((await opencorp(["devices", "list"])).stdout).toBe(`${me.device}  (this device)\n`)

    // Logging out removes the last device, so the office is open again.
    await opencorp(["logout"])
    const people = await owned.request("GET", "/people", { anonymous: true })
    expect(people.status).toBe(200)
    await people.body?.cancel()
    expect(owned.gitLog()[0]).toBe(`devices(@ngocbh): remove ${me.device}`)
    for (const text of outputs) expect(text).not.toContain(me.token)
  },
  TIMEOUT,
)

/** Opens the stream at `target` as this device: resolves once it sent `: connected`, with `ended`, which resolves once
 *  the office ends the stream. */
async function stream(office: RunningOffice, target: string): Promise<{ ended: Promise<string> }> {
  const reply = await office.request("GET", target)
  expect(reply.status).toBe(200)
  const reader = reply.body!.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  while (!seen.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) break
    seen += decoder.decode(value)
  }
  expect(seen).toStartWith(": connected")
  const ended = (async () => {
    try {
      while (!(await reader.read()).done);
      return "ended"
    } catch {
      return "cut"
    }
  })()
  return { ended }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  "removing a device ends the event stream it opened",
  async () => {
    const owned = await openOffice({ device: true })
    const workspace = folder(path.join(owned.root, "project"))
    const me = readIdentity(path.join(owned.home, "identity.json"))!
    const events = await stream(owned, "/events")
    expect(await Promise.race([events.ended, sleep(500).then(() => "open")])).toBe("open")
    await owned.opencorp(["devices", "remove", "ngocbh", me.device], { cwd: workspace })
    expect(await Promise.race([events.ended, sleep(10_000).then(() => "still open")])).not.toBe("still open")
    // The client's reconnect is refused, which the TUI shows as an unknown device.
    const again = await owned.request("GET", "/events")
    expect([again.status, ((await again.json()) as { error: string }).error]).toEqual([401, "bad_token"])
  },
  TIMEOUT,
)
