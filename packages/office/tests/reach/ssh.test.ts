/** The SSH plumbing: generated configs and the wrapper, the child runner, the node master, mux and control commands,
 *  and the watcher. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import { configText, defaultIncludes, wrapperText, writeSshFiles } from "../../src/reach/ssh.ts"
import { shortDir } from "../helpers.ts"

setDefaultTimeout(30_000)

test("the generated config puts our options before the includes, since ssh keeps the first value", () => {
  expect(configText("/h/hq/cm", { includes: ["/t/a b/cfg"] })).toBe(
    [
      "# Written by opencorp hq on each visit; edits are lost.",
      "ControlMaster auto",
      "ControlPath /h/hq/cm/%C",
      "ControlPersist 60",
      "ServerAliveInterval 15",
      "ServerAliveCountMax 3",
      'Include "/t/a b/cfg"',
      "",
    ].join("\n"),
  )
  const batch = configText("/h/hq/cm", { batch: true, includes: [] }).split("\n")
  expect(batch.slice(0, 3)).toEqual([
    "# Written by opencorp hq on each visit; edits are lost.",
    "BatchMode yes",
    "ControlMaster auto",
  ])
  expect(batch.some((line) => line.startsWith("Include"))).toBe(false)
  expect(() => configText("/h/hq/cm", { includes: ['/t/a"b'] })).toThrow()
  expect(() => configText("/h/hq/cm", { includes: ["/t/a\nProxyCommand x"] })).toThrow()
  expect(defaultIncludes("/u")).toEqual(["/u/.ssh/config", "/etc/ssh/ssh_config"])
})

test("the wrapper runs the real ssh with our config and records each exit status, even inside a pipeline", () => {
  const dir = shortDir()
  const expected = path.join(dir, "the config")
  fs.mkdirSync(path.join(dir, "real"))
  fs.mkdirSync(path.join(dir, "bin"))
  fs.writeFileSync(
    path.join(dir, "real", "ssh"),
    '#!/bin/sh\n[ "$1" = -F ] && [ "$2" = "$EXPECT" ] || exit 9; [ "$3" = bad ] && exit 255; exit 0\n',
    { mode: 0o700 },
  )
  fs.writeFileSync(path.join(dir, "bin", "ssh"), wrapperText(path.join(dir, "real", "ssh")), { mode: 0o700 })
  const env = {
    PATH: `${dir}/bin:/usr/bin:/bin`,
    OPENCORP_SSH_CONFIG: expected,
    OPENCORP_SSH_STATUS: path.join(dir, "status"),
    EXPECT: expected,
  }
  execFileSync("/bin/sh", ["-c", "ssh bad | cat; ssh good; exit 0"], { env, timeout: 10_000 })
  expect(fs.readFileSync(path.join(dir, "status"), "utf8")).toBe("255\n0\n")
  // With no status file named, it records nothing and still passes the exit through.
  const run = () =>
    execFileSync("/bin/sh", ["-c", "ssh bad; echo $?"], {
      env: { PATH: env.PATH, OPENCORP_SSH_CONFIG: expected, EXPECT: expected },
      timeout: 10_000,
    })
  expect(run().toString()).toBe("255\n")
  expect(() => wrapperText("/a/it's/ssh")).toThrow()
})

test("writeSshFiles writes the configs 0600 and the wrapper 0700", async () => {
  const paths = new ReachPaths(path.join(shortDir(), "h"))
  makeDirs(paths)
  await writeSshFiles(paths, "/usr/bin/ssh", ["/i/one"])
  expect(fs.statSync(paths.config).mode & 0o777).toBe(0o600)
  expect(fs.statSync(paths.batchConfig).mode & 0o777).toBe(0o600)
  expect(fs.statSync(paths.wrapper).mode & 0o777).toBe(0o700)
  expect(fs.readFileSync(paths.config, "utf8")).toBe(configText(paths.cm, { includes: ["/i/one"] }))
  expect(fs.readFileSync(paths.batchConfig, "utf8")).toBe(configText(paths.cm, { batch: true, includes: ["/i/one"] }))
  expect(fs.readFileSync(paths.wrapper, "utf8")).toBe(wrapperText("/usr/bin/ssh"))
})
