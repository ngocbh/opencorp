/** `opencorp install …`: the parser, help and usage errors, and each command run in-process through `main` with
 *  stand-ins for the machine. */
import fs from "node:fs"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { expect, setDefaultTimeout, test } from "bun:test"
import { main, type Setup } from "../../src/install/main.ts"
import { tempDir } from "../helpers.ts"
import { makeHost, NO_LISTING, Runner } from "./helpers.ts"

// onTestFinished hooks inherit it, and a daemon's stop can take 25 s plus a SIGKILL.
setDefaultTimeout(30_000)

/** A Writable that keeps what is written. */
function capture(): Writable & { text: () => string } {
  let text = ""
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString()
      done()
    },
  })
  return Object.assign(stream, { text: () => text })
}

/** A setup that never reaches the machine: a host whose spawns and service tools are refused, an empty env and
 *  stdin, captured output; `out()` and `err()` give the text written. */
function standIns(dir: string) {
  const stdout = capture()
  const stderr = capture()
  const setup = {
    host: makeHost(dir, new Runner()),
    environ: {},
    stdin: Readable.from([]),
    stdout,
    stderr,
    doctor: {
      probe: async () => null,
      codex: async () => ({ name: "codex", status: "ok" as const, detail: "stand-in" }),
    },
    listers: NO_LISTING,
    checkModel: async () => null,
    guardStdout: () => {
      throw new Error("in-process tests never guard stdout")
    },
  } satisfies Partial<Setup>
  return { ...setup, out: () => stdout.text(), err: () => stderr.text() }
}

test.each(["init", "onboard"])("json prompts and provider stdin together are refused [%s]", async (command) => {
  const dir = tempDir()
  const s = standIns(dir)
  expect(await main([command, "--home", dir, "--json-prompts", "--provider-stdin"], s)).toBe(2)
  expect(s.err()).toContain("not allowed with argument --json-prompts")
})

test("json prompts is not in the help", async () => {
  const s = standIns(tempDir())
  expect(await main(["init", "--help"], s)).toBe(0)
  expect(s.out()).not.toContain("--json-prompts")
  expect(s.out()).toContain("--provider-stdin")
})

test("a service mode that isnt one is a usage error", async () => {
  const s = standIns(tempDir())
  expect(await main(["init", "--service", "nope"], s)).toBe(2)
  expect(s.err()).toContain(
    "argument --service: invalid choice: 'nope' (choose from auto, launchd, systemd, tmux, background)",
  )
})

test("an unknown command is a usage error", async () => {
  const dir = tempDir()
  for (const argv of [["nope"], [], ["start", "--bogus"]]) {
    const s = standIns(dir)
    expect(await main(argv, s)).toBe(2)
    expect(s.err()).toStartWith("usage: opencorp install")
  }
})

test("doctor runs the codex check doctor has when it runs", async () => {
  const dir = tempDir()
  const s = standIns(dir)
  await main(["doctor", "--home", path.join(dir, "home")], s)
  expect(s.out()).toContain("ok    codex        stand-in")
})

test("doctor on a fresh machine fails and says to onboard", async () => {
  const dir = tempDir()
  const s = standIns(dir)
  expect(await main(["doctor", "--home", path.join(dir, "home")], s)).toBe(1)
  expect(s.out()).toContain("fail  company      no company repo")
})

test("the home defaults to opencorp home", async () => {
  const dir = tempDir()
  const s = { ...standIns(dir), environ: { OPENCORP_HOME: path.join(dir, "elsewhere") } }
  await main(["doctor"], s)
  expect(s.out()).toContain(`no company repo at ${fs.realpathSync(dir)}/elsewhere/company`)
})

test("an empty opencorp home means the default", async () => {
  const dir = tempDir()
  const s = { ...standIns(dir), environ: { OPENCORP_HOME: "" } }
  await main(["doctor"], s)
  expect(s.out()).toContain(`no company repo at ${dir}/.opencorp/company`)
})
