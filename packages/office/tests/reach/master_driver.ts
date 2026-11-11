/** Holds a real node master for a test, as a visit would, until the test kills it:
 *
 *      bun master_driver.ts <home> <plain|watcher|jump> <port>
 *
 *  It starts the watcher (unless `plain`), the node master to 127.0.0.1 and waits for its socket; in `jump` mode it
 *  first runs `ssh localhost true` through the wrapper, as reach.sh would, and the master's hop rides the login master
 *  that leaves. Unless `plain` it forwards 127.0.0.1:<port> to `<home>/hq.sock`. Then it starts `sleep 30` (after both
 *  pipes, so a leaked write end would show), prints `up <its pid>`, and exits after 60 s. The ssh files under
 *  `<home>/hq` are the test's. */
import { spawn } from "node:child_process"
import { ReachPaths } from "../../src/reach/paths.ts"
import {
  forward,
  LIMITS,
  type ReachContext,
  runChild,
  sshEnv,
  startMaster,
  startWatcher,
  waitForSocket,
} from "../../src/reach/ssh.ts"

const [home, mode, port] = process.argv.slice(2) as [string, string, string]
const ctx: ReachContext = {
  paths: new ReachPaths(home),
  ssh: "/usr/bin/ssh",
  env: { PATH: "/usr/bin:/bin", HOME: home },
  batch: false,
  echo: () => {},
  limits: LIMITS,
}
const spec = { host: "127.0.0.1", opencorp: "/o/opencorp", ...(mode === "jump" ? { jump: ["localhost"] } : {}) }
if (mode !== "plain") startWatcher(ctx)
if (mode === "jump") {
  const login = await runChild([ctx.paths.wrapper, "localhost", "true"], { env: sshEnv(ctx), cwd: ctx.paths.dir, timeoutMs: 30_000 })
  if (login.code !== 0) {
    console.log(`failed login ${login.code}`)
    process.exit(1)
  }
}
const master = startMaster(ctx, spec, { quiet: true })
const up = await waitForSocket(master, 20_000)
if (up !== "up") {
  console.log(`failed ${up}`)
  process.exit(1)
}
if (mode !== "plain" && (await forward(ctx, spec, Number(port), `${home}/hq.sock`)).code !== 0) {
  console.log("failed forward")
  process.exit(1)
}
const sleep = spawn("/bin/sleep", ["30"], { stdio: "ignore" })
console.log(`up ${sleep.pid}`)
setTimeout(() => process.exit(0), 60_000)
