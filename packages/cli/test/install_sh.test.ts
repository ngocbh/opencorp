/**
 * `install.sh` and `uninstall.sh` at the repo root. Each test runs them with an explicit env: a temp `HOME`, a plain
 * PATH behind a stub `bun` and `curl`, and a fixture repo as `--repo`, so nothing outside the temp dir changes and
 * nothing reaches the network. The stubs log each call to `$STUB_LOG/calls`. A run without a terminal gets a session
 * of its own, so `/dev/tty` can't open; a run on a terminal gets a tmux window.
 *
 * With OPENCORP_TEST_INSTALL=1, one more test installs a clone of this checkout with the real Bun, offline from Bun's
 * real package cache.
 */
import { afterAll, beforeAll, describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

setDefaultTimeout(60_000)

const CHECKOUT = fs.realpathSync(path.resolve(import.meta.dir, "../../.."))
const SYSTEM = "/usr/bin:/bin"
const MARK = "opencorp install.sh"
/** The end of each PATH line install.sh writes. */
const SUFFIX = `  # added by ${MARK}`
/** The POSIX shells here to run the scripts under. */
const SHELLS = ["sh", "bash", "dash", "ksh"].filter((shell) => Bun.which(shell, { PATH: SYSTEM }))
const TMUX = Bun.which("tmux", { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" })

/** Everything this file makes. */
let root = ""
/** The fixture OpenCorp repo: `main`, and a `next` branch one commit ahead. */
let source = ""
/** A folder holding only the stub `bun`. */
let bunDir = ""
/** A folder holding the stub `curl`, whose Bun installer copies the stub `bun`. */
let stubs = ""

/** `s` as one sh word. */
const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** Git config as env: file submodules may be cloned, and each `[from, to]` URL goes to `to`. */
function gitConfig(urls: [string, string][] = []): Record<string, string> {
  const pairs: [string, string][] = [
    ["protocol.file.allow", "always"],
    ...urls.map(([from, to]): [string, string] => [`url.${to}.insteadOf`, from]),
  ]
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: String(pairs.length) }
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  return env
}

/** Runs git in `cwd` as the fixtures' author. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      PATH: SYSTEM,
      HOME: path.join(root, "git-home"),
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      ...gitConfig(),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim()
}

function writeScript(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode: 0o755 })
}

/** Commits a new file `name` in the repo `dir`. */
function commitFile(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, name), `${name}\n`)
  git(dir, "add", name)
  git(dir, "commit", "-q", "-m", name)
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-install-sh-")))
  fs.mkdirSync(path.join(root, "git-home"))

  const yian = path.join(root, "yian")
  fs.mkdirSync(yian)
  git(yian, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(yian, ".gitignore"), "node_modules/\n")
  git(yian, "add", ".gitignore")
  commitFile(yian, "README")

  // An OpenCorp checkout as far as the scripts see one: the root package.json, the real wrapper, and a submodule.
  source = path.join(root, "source")
  fs.mkdirSync(source)
  git(source, "init", "-q", "-b", "main")
  const pkg = { name: "opencorp-workspace", private: true, packageManager: "bun@1.4.2", scripts: { build: "true" } }
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
  // What this repo ignores.
  fs.writeFileSync(path.join(source, ".gitignore"), fs.readFileSync(path.join(CHECKOUT, ".gitignore"), "utf8"))
  const wrapper = fs.readFileSync(path.join(CHECKOUT, "packages/cli/bin/opencorp"), "utf8")
  writeScript(path.join(source, "packages/cli/bin/opencorp"), wrapper)
  for (const script of ["install.sh", "uninstall.sh"]) {
    writeScript(path.join(source, script), fs.readFileSync(path.join(CHECKOUT, script), "utf8"))
  }
  git(source, "submodule", "add", "-q", yian, "packages/yian")
  git(source, "add", ".")
  git(source, "commit", "-q", "-m", "opencorp")
  git(source, "checkout", "-q", "-b", "next")
  commitFile(source, "NEXT")
  git(source, "checkout", "-q", "main")

  // The stub bun logs its calls (and whether stdin is a terminal), answers `--version` for itself and for
  // `opencorp --version`, and stands in for `opencorp offboard` by removing the office's state.
  bunDir = path.join(root, "bun-bin")
  writeScript(
    path.join(bunDir, "bun"),
    `#!/bin/sh
if [ -t 0 ]; then tty=tty; else tty=no-tty; fi
printf '%s %s | %s | %s\\n' "$0" "$*" "$PWD" "$tty" >>"$STUB_LOG/calls"
case $* in
  --version) echo "\${STUB_BUN_VERSION:-1.4.2}" ;;
  *" --version") echo 0.0.1 ;;
  *" offboard")
    [ -z "\${STUB_OFFBOARD_FAILS:-}" ] || exit 1
    rm -rf "$HOME/.opencorp/office" "$HOME/.opencorp/identity.json" ;;
esac
`,
  )
  // The stub curl serves a Bun installer that logs its arguments and puts the stub bun where Bun's would go.
  stubs = path.join(root, "stubs")
  writeScript(
    path.join(stubs, "curl"),
    `#!/bin/sh
printf 'curl %s\\n' "$*" >>"$STUB_LOG/calls"
cat <<'EOF'
printf 'bun-installer %s\\n' "$*" >>"$STUB_LOG/calls"
mkdir -p "\${BUN_INSTALL:-$HOME/.bun}/bin"
cp ${sq(path.join(bunDir, "bun"))} "\${BUN_INSTALL:-$HOME/.bun}/bin/bun"
EOF
`,
  )
})

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

interface Home {
  /** The test's own folder, outside the home. */
  dir: string
  home: string
  log: string
  bin: string
  wrapper: string
  /** Where a clone goes by default. */
  clone: string
  office: string
}

function makeHome(): Home {
  const dir = fs.mkdtempSync(path.join(root, "t-"))
  const home = path.join(dir, "home")
  const log = path.join(dir, "log")
  fs.mkdirSync(home)
  fs.mkdirSync(log)
  const bin = path.join(home, ".local", "bin")
  return {
    dir,
    home,
    log,
    bin,
    wrapper: path.join(bin, "opencorp"),
    clone: path.join(home, ".local", "share", "opencorp"),
    office: path.join(home, ".opencorp"),
  }
}

/** The fixture cloned into the test's folder, as a checkout someone cloned themselves. */
function checkout(h: Home, name = "checkout"): string {
  const dir = path.join(h.dir, name)
  git(h.dir, "clone", "-q", source, dir)
  return dir
}

/** The env the scripts run with: the temp home, bash, and the stubs ahead of a plain PATH. */
function env(h: Home, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: h.home, SHELL: "/bin/bash", PATH: `${bunDir}:${stubs}:${SYSTEM}`, STUB_LOG: h.log, ...gitConfig(), ...extra }
}

interface RunOptions {
  args?: string[]
  extra?: Record<string, string>
  shell?: string
  /** Shell commands run first, in the same process, before the script. */
  wrap?: string
  /** Run from a checkout's copy of the script, as `./install.sh` does; otherwise piped, as `curl | bash` does. */
  from?: string
  cwd?: string
}

interface Result {
  code: number | null
  out: string
  err: string
}

/** The shell's arguments and stdin for `script`: piped from this repo's copy (install.sh with `--repo` the fixture),
 *  or run from a checkout. */
function argv(script: string, o: RunOptions): { args: string[]; input?: string } {
  const repo = !o.from && script === "install.sh" && !o.args?.includes("--repo") ? ["--repo", source] : []
  const args = [...repo, ...(o.args ?? [])]
  if (o.from) return { args: [path.join(o.from, script), ...args] }
  return { args: ["-s", "--", ...args], input: path.join(CHECKOUT, script) }
}

/** Runs `script` with no terminal: in a session of its own, so it has no controlling terminal. */
async function run(h: Home, script: string, o: RunOptions = {}): Promise<Result> {
  const { args, input } = argv(script, o)
  const stdin = input ? fs.openSync(input, "r") : "ignore"
  const shell = o.shell ?? "sh"
  const command = o.wrap ? [shell, "-c", `${o.wrap} exec ${shell} "$@"`, shell, ...args] : [shell, ...args]
  const child = spawn(command[0]!, command.slice(1), {
    cwd: o.cwd ?? h.home,
    env: env(h, o.extra),
    detached: true,
    stdio: [stdin, "pipe", "pipe"],
  })
  if (typeof stdin === "number") fs.closeSync(stdin)
  let out = ""
  let err = ""
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (out += chunk))
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (err += chunk))
  const timer = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 60_000)
  const code = await new Promise<number | null>((resolve) => child.on("close", (status) => resolve(status)))
  clearTimeout(timer)
  return { code, out, err }
}

/** Runs `script` on a terminal: a tmux window of its own, killed when the test finishes. */
function onTerminal(h: Home, script: string, o: RunOptions = {}) {
  const server = `oc-install-${randomBytes(4).toString("hex")}`
  const tmux = (...args: string[]) =>
    execFileSync(TMUX!, ["-L", server, ...args], {
      env: { PATH: SYSTEM },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })
  const exitFile = path.join(h.dir, `exit-${server}`)
  const { args, input } = argv(script, o)
  const vars = Object.entries({ ...env(h, o.extra), TERM: "xterm" }).map(([k, v]) => sq(`${k}=${v}`))
  const command =
    `cd ${sq(o.cwd ?? h.home)} && env -i ${vars.join(" ")} ${o.shell ?? "sh"} ${args.map(sq).join(" ")}` +
    `${input ? ` < ${sq(input)}` : ""}; echo exit=$? > ${sq(exitFile)}`
  // The window stays once the script ends, so its last lines can still be read.
  const conf = path.join(root, "tmux.conf")
  if (!fs.existsSync(conf)) fs.writeFileSync(conf, "set -g remain-on-exit on\n")
  tmux("-f", conf, "new-session", "-d", "-s", "t", "-x", "160", "-y", "50", command)
  onTestFinished(() => {
    try {
      tmux("kill-server")
    } catch {}
    fs.rmSync(path.join("/tmp", `tmux-${process.getuid!()}`, server), { force: true })
  })
  const screen = () => {
    try {
      return tmux("capture-pane", "-p", "-J", "-S", "-", "-t", "t")
    } catch {
      return ""
    }
  }
  const ended = () => fs.existsSync(exitFile) && fs.readFileSync(exitFile, "utf8").includes("\n")
  return {
    screen,
    /** Waits until the window shows `text`. */
    async see(text: string, ms = 30_000) {
      const deadline = performance.now() + ms
      while (!screen().includes(text)) {
        if (ended()) throw new Error(`${script} ended before showing ${text}:\n${screen()}`)
        if (performance.now() > deadline) throw new Error(`no ${text} within ${ms} ms:\n${screen()}`)
        await Bun.sleep(50)
      }
    },
    /** Types `text` as is, then Enter. */
    type(text: string) {
      if (text) tmux("send-keys", "-t", "t", "-l", text)
      tmux("send-keys", "-t", "t", "Enter")
    },
    /** The exit status, once the script has ended. */
    async exit(ms = 30_000) {
      const deadline = performance.now() + ms
      while (!ended()) {
        if (performance.now() > deadline) throw new Error(`${script} didn't end within ${ms} ms:\n${screen()}`)
        await Bun.sleep(50)
      }
      return Number(fs.readFileSync(exitFile, "utf8").trim().replace("exit=", ""))
    },
  }
}

/** The stubs' calls, one line each. */
function calls(h: Home): string[] {
  const file = path.join(h.log, "calls")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []
}

/** How many of the installer's PATH lines `rc` holds: lines that end in its marker. */
function pathLines(rc: string): number {
  if (!fs.existsSync(rc)) return 0
  return fs
    .readFileSync(rc, "latin1")
    .split("\n")
    .filter((line) => line.endsWith(SUFFIX)).length
}

/** Runs the installed wrapper with `args`, with no Bun on PATH. */
function runWrapper(h: Home, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(h.wrapper, args, {
    env: { PATH: SYSTEM, STUB_LOG: h.log, ...extra },
    encoding: "utf8",
    timeout: 30_000,
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

describe("install.sh", () => {
  test("run from a checkout, it installs and builds that checkout and writes a marked wrapper that runs it with the Bun it found", async () => {
    const h = makeHome()
    const co = checkout(h)
    for (let i = 0; i < 2; i++) {
      const r = await run(h, "install.sh", { from: co })
      expect(r.err).not.toContain("✗")
      expect(r.code).toBe(0)
      expect(r.out).toContain(`✓ Installing the checkout at ${co}`)
      expect(r.out).toContain(`✓ Installed OpenCorp 0.0.1 from ${co}`)
      expect(r.out).toContain("→ Next: in a project folder, run opencorp init.")
      expect(r.out).toContain(`→ To use opencorp in this shell, run: . ${h.home}/.bashrc`)
      // No terminal, so no colour.
      expect(r.out + r.err).not.toContain("\x1b[")
    }
    const bun = path.join(bunDir, "bun")
    expect(calls(h).filter((c) => c.startsWith(`${bun} install --frozen-lockfile | ${co} |`))).toHaveLength(2)
    expect(calls(h).filter((c) => c.startsWith(`${bun} run build | ${co} |`))).toHaveLength(2)
    expect(calls(h).filter((c) => c.includes(" init "))).toEqual([])
    expect(fs.readFileSync(h.wrapper, "utf8")).toContain(MARK)
    expect(fs.existsSync(h.clone)).toBe(false)
    expect(pathLines(path.join(h.home, ".bashrc"))).toBe(1)
    expect(pathLines(path.join(h.home, ".profile"))).toBe(1)

    // The wrapper runs the checkout's own wrapper with that Bun, with no Bun on PATH; a Bun in OPENCORP_BUN wins.
    expect(runWrapper(h, ["--version"]).out.trim()).toBe("0.0.1")
    expect(calls(h).at(-1)).toStartWith(
      `${bun} --no-install --no-env-file --config=/dev/null ${co}/packages/cli/src/main.ts --version |`,
    )
    const other = path.join(h.dir, "other-bun")
    writeScript(other, "#!/bin/sh\necho other bun\n")
    expect(runWrapper(h, ["--version"], { OPENCORP_BUN: other }).out.trim()).toBe("other bun")
  })

  test("leaves the rc files alone when the bin folder is on PATH already, or with --no-modify-path", async () => {
    const h = makeHome()
    const co = checkout(h)
    const r = await run(h, "install.sh", { from: co, extra: { PATH: `${h.bin}:${bunDir}:${stubs}:${SYSTEM}` } })
    expect(r.code).toBe(0)
    expect(fs.existsSync(h.wrapper)).toBe(true)
    expect(r.out).not.toContain("To use opencorp in this shell")
    const again = await run(h, "install.sh", { from: co, args: ["--no-modify-path"] })
    expect(again.code).toBe(0)
    expect(again.err).toContain(`⚠ ${h.bin} isn't on your PATH`)
    expect(fs.readdirSync(h.home).filter((f) => f.startsWith("."))).toEqual([".local"])
  })

  test("takes the bin folder from OPENCORP_BIN_DIR", async () => {
    const h = makeHome()
    const bin = path.join(h.home, "tools")
    const r = await run(h, "install.sh", { from: checkout(h), extra: { OPENCORP_BIN_DIR: bin } })
    expect(r.code).toBe(0)
    expect(fs.readFileSync(path.join(bin, "opencorp"), "utf8")).toContain(MARK)
    expect(fs.existsSync(h.wrapper)).toBe(false)
  })

  test("refuses an opencorp it didn't write before it clones or installs anything", async () => {
    const h = makeHome()
    writeScript(h.wrapper, "#!/bin/sh\necho mine\n")
    const r = await run(h, "install.sh")
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(`✗ ${h.wrapper} exists and was not written by install.sh`)
    expect(fs.readFileSync(h.wrapper, "utf8")).toContain("echo mine")
    expect(fs.existsSync(h.clone)).toBe(false)
    expect(calls(h)).toEqual([])
  })

  test("replaces a link to an OpenCorp checkout's wrapper, which the README's manual steps made, and says where it pointed", async () => {
    const h = makeHome()
    const theirs = path.join(checkout(h, "mine"), "packages/cli/bin/opencorp")
    const before = fs.readFileSync(theirs, "utf8")
    fs.mkdirSync(h.bin, { recursive: true })
    fs.symlinkSync(theirs, h.wrapper)
    const co = checkout(h)
    const r = await run(h, "install.sh", { from: co })
    expect(r.code).toBe(0)
    expect(r.out).toContain(`✓ Replaced ${h.wrapper}, a link to ${theirs}, with a wrapper for ${co}`)
    expect(fs.lstatSync(h.wrapper).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(h.wrapper, "utf8")).toContain(MARK)
    expect(fs.readFileSync(theirs, "utf8")).toBe(before)
  })

  test("refuses a Bun older than packageManager's and names its version, and takes any later one", async () => {
    for (const version of ["1.4.1", "1.3.9", "0.9.10"]) {
      const h = makeHome()
      const r = await run(h, "install.sh", { from: checkout(h), extra: { STUB_BUN_VERSION: version } })
      expect(r.code).not.toBe(0)
      expect(r.err).toContain(`OpenCorp needs Bun 1.4.2 or later; ${path.join(bunDir, "bun")} is ${version}`)
      expect(fs.existsSync(h.wrapper)).toBe(false)
    }
    for (const version of ["1.4.10", "1.10.0", "2.0.0", "1.4.3-canary.1+abc"]) {
      const h = makeHome()
      const r = await run(h, "install.sh", { from: checkout(h), extra: { STUB_BUN_VERSION: version } })
      expect(r.err).not.toContain("✗")
      expect(r.code).toBe(0)
    }
  })

  test("with no Bun anywhere, installs packageManager's version with Bun's installer and builds with it by its path", async () => {
    const h = makeHome()
    const co = checkout(h)
    const noBun = { PATH: `${stubs}:${SYSTEM}` }
    const r = await run(h, "install.sh", { from: co, extra: noBun })
    expect(r.err).not.toContain("✗")
    expect(r.code).toBe(0)
    const bun = path.join(h.home, ".bun/bin/bun")
    expect(r.out).toContain(`→ Installing Bun 1.4.2 into ${h.home}/.bun with https://bun.sh/install`)
    expect(calls(h).slice(0, 3)).toEqual([
      "curl -fsSL https://bun.sh/install",
      "bun-installer bun-v1.4.2",
      `${bun} --version | ${h.home} | no-tty`,
    ])
    expect(calls(h)).toContain(`${bun} install --frozen-lockfile | ${co} | no-tty`)
    expect(fs.readFileSync(h.wrapper, "utf8")).toContain(sq(bun))

    // Run again, Bun's own install folder holds a Bun, so its installer isn't fetched again.
    expect((await run(h, "install.sh", { from: co, extra: noBun })).code).toBe(0)
    expect(calls(h).filter((c) => c.startsWith("curl"))).toHaveLength(1)
  })

  test("piped, clones --repo with its submodule into ~/.local/share/opencorp and marks the clone, even from inside a checkout", async () => {
    const h = makeHome()
    const r = await run(h, "install.sh", { cwd: checkout(h) })
    expect(r.err).not.toContain("✗")
    expect(r.code).toBe(0)
    expect(r.out).toContain(`→ Cloning ${source} (main) into ${h.clone}`)
    expect(fs.existsSync(path.join(h.clone, ".git/opencorp-installer"))).toBe(true)
    expect(fs.readFileSync(path.join(h.clone, "packages/yian/README"), "utf8")).toBe("README\n")
    expect(fs.existsSync(path.join(h.clone, "NEXT"))).toBe(false)
    expect(r.out).toContain(`✓ Installed OpenCorp 0.0.1 from ${h.clone}`)
    expect(fs.readFileSync(h.wrapper, "utf8")).toContain(sq(path.join(h.clone, "packages/cli/bin/opencorp")))
  })

  test("piped, clones into --dir over OPENCORP_INSTALL_DIR, on the --branch asked for, and from OPENCORP_REPO_URL", async () => {
    const h = makeHome()
    const dir = path.join(h.home, "apps", "opencorp")
    const r = await run(h, "install.sh", {
      args: ["--dir", dir, "--branch", "next"],
      extra: { OPENCORP_INSTALL_DIR: path.join(h.home, "elsewhere") },
    })
    expect(r.code).toBe(0)
    expect(fs.existsSync(path.join(dir, ".git/opencorp-installer"))).toBe(true)
    expect(fs.existsSync(path.join(dir, "NEXT"))).toBe(true)
    expect(fs.existsSync(path.join(h.home, "elsewhere"))).toBe(false)

    const other = makeHome()
    const viaEnv = path.join(other.home, "apps", "opencorp")
    const byEnv = await run(other, "install.sh", {
      args: ["--skip-setup"],
      extra: { OPENCORP_INSTALL_DIR: viaEnv, OPENCORP_REPO_URL: source },
    })
    expect(byEnv.code).toBe(0)
    expect(fs.existsSync(path.join(viaEnv, ".git/opencorp-installer"))).toBe(true)
    expect(fs.existsSync(other.clone)).toBe(false)
  })

  test("piped again, it updates a clean clone to the remote's new commit", async () => {
    const h = makeHome()
    const remote = checkout(h, "remote")
    expect((await run(h, "install.sh", { args: ["--repo", remote] })).code).toBe(0)
    commitFile(remote, "NEWS")
    const r = await run(h, "install.sh", { args: ["--repo", remote] })
    expect(r.err).not.toContain("✗")
    expect(r.code).toBe(0)
    expect(r.out).toContain(`→ Updating ${h.clone} (main)`)
    expect(r.out).toContain(`✓ Updated ${h.clone} to ${git(remote, "rev-parse", "--short", "HEAD")}`)
    expect(git(h.clone, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "HEAD"))
  })

  test("piped again, it refuses a clone with uncommitted changes or a detached HEAD and leaves it as it was", async () => {
    const h = makeHome()
    expect((await run(h, "install.sh")).code).toBe(0)
    const edited = path.join(h.clone, "packages/cli/bin/opencorp")
    fs.appendFileSync(edited, "# a local edit\n")
    const dirty = await run(h, "install.sh")
    expect(dirty.code).not.toBe(0)
    expect(dirty.err).toContain(`✗ ${h.clone} has uncommitted changes`)
    expect(fs.readFileSync(edited, "utf8")).toEndWith("# a local edit\n")

    git(h.clone, "checkout", "-q", "--", "packages/cli/bin/opencorp")
    git(h.clone, "checkout", "-q", "--detach")
    const detached = await run(h, "install.sh")
    expect(detached.code).not.toBe(0)
    expect(detached.err).toContain(`✗ ${h.clone} isn't on a branch`)
  })

  test("piped, it refuses a folder at the install dir that isn't an OpenCorp clone", async () => {
    const h = makeHome()
    fs.mkdirSync(h.clone, { recursive: true })
    fs.writeFileSync(path.join(h.clone, "notes"), "mine\n")
    const r = await run(h, "install.sh")
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(`✗ ${h.clone} holds something other than an OpenCorp clone`)
    expect(fs.readdirSync(h.clone)).toEqual(["notes"])
  })

  test.skipIf(process.platform !== "linux")("on Linux, warns with how to install bubblewrap when there's no bwrap", async () => {
    // A PATH holding every system command but bwrap.
    const tools = path.join(root, "no-bwrap")
    if (!fs.existsSync(tools)) {
      fs.mkdirSync(tools)
      for (const dir of SYSTEM.split(":")) {
        for (const name of fs.readdirSync(dir)) {
          const to = path.join(tools, name)
          if (name !== "bwrap" && !fs.existsSync(to)) fs.symlinkSync(path.join(dir, name), to)
        }
      }
    }
    const h = makeHome()
    const r = await run(h, "install.sh", { from: checkout(h), extra: { PATH: `${bunDir}:${stubs}:${tools}` } })
    expect(r.code).toBe(0)
    expect(r.err).toContain("⚠ bubblewrap (bwrap) is missing")
    expect(r.err).toContain("apt install bubblewrap")
    if (Bun.which("bwrap", { PATH: SYSTEM })) {
      const again = makeHome()
      expect((await run(again, "install.sh", { from: checkout(again) })).err).not.toContain("bwrap")
    }
  })

  test("puts the bin folder on PATH in each login shell's rc files, once, after a last line with no newline", async () => {
    const cases: [string, string[]][] = [
      ["/usr/bin/zsh", [".zshrc", ".zprofile"]],
      ["/usr/bin/fish", [".config/fish/config.fish"]],
      ["/bin/bash", [".bashrc", ".profile", ".bash_profile"]],
      ["/bin/sh", [".profile"]],
    ]
    for (const [shell, files] of cases) {
      const h = makeHome()
      const co = checkout(h)
      // A login bash reads .bash_profile when it's there, so that gets the line too.
      fs.writeFileSync(path.join(h.home, ".bash_profile"), "alias ll='ls -l'")
      for (let i = 0; i < 2; i++) expect((await run(h, "install.sh", { from: co, extra: { SHELL: shell } })).code).toBe(0)
      const all = [".zshrc", ".zprofile", ".config/fish/config.fish", ".bashrc", ".profile", ".bash_profile"]
      expect(all.filter((f) => pathLines(path.join(h.home, f)) > 0)).toEqual(files)
      for (const f of files) expect(pathLines(path.join(h.home, f))).toBe(1)
      if (files.includes(".bash_profile")) {
        expect(fs.readFileSync(path.join(h.home, ".bash_profile"), "utf8")).toStartWith("alias ll='ls -l'\ncase ")
      }
      if (shell.endsWith("fish")) {
        expect(fs.readFileSync(path.join(h.home, ".config/fish/config.fish"), "utf8")).toBe(
          `fish_add_path --path ${sq(h.bin)}${SUFFIX}\n`,
        )
      }

      // Uninstall takes each line out again, and the files install made, now empty, go too.
      const r = await run(h, "uninstall.sh", { extra: { SHELL: shell } })
      expect(r.err).not.toContain("✗")
      expect(r.code).toBe(0)
      for (const f of all) expect(pathLines(path.join(h.home, f))).toBe(0)
      expect(all.filter((f) => fs.existsSync(path.join(h.home, f)))).toEqual([".bash_profile"])
      // Only a file install added to gains a final newline.
      const ending = files.includes(".bash_profile") ? "\n" : ""
      expect(fs.readFileSync(path.join(h.home, ".bash_profile"), "utf8")).toBe(`alias ll='ls -l'${ending}`)
    }
  })

  test("the PATH lines it writes add the bin folder once however often a shell reads them", async () => {
    const h = makeHome()
    const co = checkout(h)
    for (const shell of ["/bin/sh", "/usr/bin/fish"]) {
      expect((await run(h, "install.sh", { from: co, extra: { SHELL: shell } })).code).toBe(0)
    }
    const profile = path.join(h.home, ".profile")
    for (const shell of [...SHELLS, ...(Bun.which("zsh", { PATH: SYSTEM }) ? ["zsh"] : [])]) {
      const result = spawnSync(shell, ["-c", `. ${sq(profile)}; . ${sq(profile)}; printf '%s' "$PATH"`], {
        env: { PATH: SYSTEM, HOME: h.home },
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(result.stdout).toBe(`${h.bin}:${SYSTEM}`)
    }
    const fish = Bun.which("fish", { PATH: SYSTEM })
    if (fish) {
      // With its config, as a login fish starts: --no-config leaves out what applies fish_add_path to PATH.
      const config = path.join(h.home, ".config/fish/config.fish")
      const result = spawnSync(fish, ["-c", `source ${sq(config)}; string join : $PATH`], {
        env: { PATH: SYSTEM, HOME: h.home, XDG_CONFIG_HOME: path.join(h.home, ".config") },
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(result.stdout.trim().split(":").filter((dir) => dir === h.bin)).toEqual([h.bin])
      // The user's own fish_add_path, after the line has run, still saves its folder for good.
      const theirs = path.join(h.dir, "their-bin")
      fs.mkdirSync(theirs)
      const scope = spawnSync(fish, ["-c", `fish_add_path ${sq(theirs)}; set --show fish_user_paths`], {
        env: { PATH: SYSTEM, HOME: h.home, XDG_CONFIG_HOME: path.join(h.home, ".config") },
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(scope.stdout).toContain("$fish_user_paths: set in universal scope")
      expect(scope.stdout).not.toContain("$fish_user_paths: set in global scope")
    }
  })

  test("leaves an rc file alone that already puts the bin folder on PATH", async () => {
    const h = makeHome()
    // Ubuntu's own .profile does this.
    const profile = 'if [ -d "$HOME/.local/bin" ] ; then\n    PATH="$HOME/.local/bin:$PATH"\nfi\n'
    fs.writeFileSync(path.join(h.home, ".profile"), profile)
    expect((await run(h, "install.sh", { from: checkout(h) })).code).toBe(0)
    expect(fs.readFileSync(path.join(h.home, ".profile"), "utf8")).toBe(profile)
    expect(pathLines(path.join(h.home, ".bashrc"))).toBe(1)
  })

  test("a line that only looks like it puts the bin folder on PATH doesn't count", async () => {
    const h = makeHome()
    fs.writeFileSync(path.join(h.home, ".bashrc"), '[ "$(hostname)" = laptop ] && export PATH="$HOME/.local/bin:$PATH"\n')
    fs.writeFileSync(path.join(h.home, ".profile"), 'export PYTHONPATH="$HOME/.local/bin/pylib"\n')
    expect((await run(h, "install.sh", { from: checkout(h) })).code).toBe(0)
    expect(pathLines(path.join(h.home, ".bashrc"))).toBe(1)
    expect(pathLines(path.join(h.home, ".profile"))).toBe(1)
  })

  test("a line of the user's that mentions opencorp install.sh is theirs: install adds its own, and uninstall leaves theirs", async () => {
    const h = makeHome()
    const theirs = 'export PATH="$HOME/go/bin:$PATH"  # moved here; see opencorp install.sh notes\n'
    fs.writeFileSync(path.join(h.home, ".bashrc"), theirs)
    expect((await run(h, "install.sh")).code).toBe(0)
    expect(pathLines(path.join(h.home, ".bashrc"))).toBe(1)
    expect((await run(h, "uninstall.sh")).code).toBe(0)
    expect(fs.readFileSync(path.join(h.home, ".bashrc"), "utf8")).toBe(theirs)
  })

  test("skips an rc file it can't write, with a warning that gives the line to add", async () => {
    const h = makeHome()
    const bashrc = path.join(h.home, ".bashrc")
    fs.writeFileSync(bashrc, "alias ll='ls -l'\n", { mode: 0o444 })
    const r = await run(h, "install.sh", { from: checkout(h) })
    expect(r.code).toBe(0)
    expect(r.err).toContain(`⚠ Can't write ${bashrc}, so add this line to it yourself: case `)
    expect(fs.readFileSync(bashrc, "utf8")).toBe("alias ll='ls -l'\n")
    expect(pathLines(path.join(h.home, ".profile"))).toBe(1)
    expect(r.out).toContain("✓ Installed OpenCorp 0.0.1")
  })

  test("with an office set up, it says to restart the office instead of offering to create one", async () => {
    const h = makeHome()
    fs.mkdirSync(path.join(h.office, "office"), { recursive: true })
    const r = await run(h, "install.sh", { from: checkout(h) })
    expect(r.code).toBe(0)
    expect(r.out).toContain(`✓ An office is set up at ${h.office}: run opencorp restart to use this version.`)
    expect(r.out).not.toContain("opencorp init")
  })

  describe.skipIf(!TMUX)("on a terminal", () => {
    test("it offers to create the company, makes the project folder it's given, and runs opencorp init there", async () => {
      const h = makeHome()
      const t = onTerminal(h, "install.sh")
      await t.see("Create your company now? [Y/n]")
      t.type("")
      await t.see(`Project folder for it [${h.home}/projects/opencorp]:`)
      t.type("~/work/acme")
      expect(await t.exit()).toBe(0)
      const project = path.join(h.home, "work/acme")
      expect(fs.statSync(project).isDirectory()).toBe(true)
      expect(calls(h).filter((c) => c.includes("main.ts init |"))).toEqual([
        `${path.join(bunDir, "bun")} --no-install --no-env-file --config=/dev/null ${h.clone}/packages/cli/src/main.ts init | ${project} | tty`,
      ])
    })

    test("the project folder defaults to ~/projects/opencorp, and a no runs nothing", async () => {
      const h = makeHome()
      const t = onTerminal(h, "install.sh")
      await t.see("Create your company now? [Y/n]")
      t.type("")
      await t.see("Project folder for it")
      t.type("")
      expect(await t.exit()).toBe(0)
      expect(calls(h).filter((c) => c.includes("main.ts init |")).at(0)).toContain(`| ${h.home}/projects/opencorp | tty`)

      const declined = makeHome()
      const t2 = onTerminal(declined, "install.sh")
      await t2.see("Create your company now? [Y/n]")
      t2.type("n")
      expect(await t2.exit()).toBe(0)
      expect(t2.screen()).toContain("→ Next: in a project folder, run opencorp init.")
      expect(calls(declined).filter((c) => c.includes("main.ts init |"))).toEqual([])
    })

    test("--skip-setup asks nothing and prints the next step", async () => {
      const h = makeHome()
      const t = onTerminal(h, "install.sh", { args: ["--skip-setup"] })
      expect(await t.exit()).toBe(0)
      expect(t.screen()).toContain("→ Next: in a project folder, run opencorp init.")
      expect(t.screen()).not.toContain("Create your company")
    })
  })
})

describe("uninstall.sh", () => {
  test("removes the wrapper, the PATH lines and a clean clone, keeps the rest of each rc file, and says what it left", async () => {
    const h = makeHome()
    // A dotfiles link with its own mode, and a last line with no newline.
    const dotfile = path.join(h.dir, "bashrc")
    fs.writeFileSync(dotfile, "alias ll='ls -l'", { mode: 0o600 })
    fs.symlinkSync(dotfile, path.join(h.home, ".bashrc"))
    expect((await run(h, "install.sh")).code).toBe(0)
    expect(pathLines(dotfile)).toBe(1)
    const r = await run(h, "uninstall.sh")
    expect(r.err).not.toContain("✗")
    expect(r.code).toBe(0)
    expect(r.out).toContain(`✓ Removed ${h.wrapper}`)
    expect(r.out).toContain(`✓ Removed ${h.clone}`)
    expect(r.out).toContain(`✓ Left Bun and the office home (${h.office}) in place.`)
    expect(fs.existsSync(h.wrapper)).toBe(false)
    expect(fs.existsSync(h.clone)).toBe(false)
    expect(fs.lstatSync(path.join(h.home, ".bashrc")).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(dotfile, "utf8")).toBe("alias ll='ls -l'\n")
    expect(fs.statSync(dotfile).mode & 0o777).toBe(0o600)
    // install made .profile, so uninstall removes it once it's empty again.
    expect(fs.existsSync(path.join(h.home, ".profile"))).toBe(false)
  })

  test("keeps every byte of an rc file around its PATH line, in a UTF-8 locale", async () => {
    const h = makeHome()
    const utf8 = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }
    // A Latin-1 byte, a NUL, a CRLF line, and no newline at the end.
    const original = Buffer.from("export A=1\n# caf\xe9\n\x00binary\r\nalias x=y", "latin1")
    const bashrc = path.join(h.home, ".bashrc")
    fs.writeFileSync(bashrc, original)
    expect((await run(h, "install.sh", { extra: utf8 })).code).toBe(0)
    expect(pathLines(bashrc)).toBe(1)
    const r = await run(h, "uninstall.sh", { extra: utf8 })
    expect(r.err).not.toContain("✗")
    expect(r.code).toBe(0)
    expect(fs.readFileSync(bashrc)).toEqual(Buffer.concat([original, Buffer.from("\n")]))
  })

  test("leaves an rc file as it was when the new one can't be written in full, and says so with ✗", async () => {
    const h = makeHome()
    const bashrc = path.join(h.home, ".bashrc")
    const big = "# a long rc file\n".repeat(20_000)
    fs.writeFileSync(bashrc, big)
    expect((await run(h, "install.sh")).code).toBe(0)
    const before = fs.readFileSync(bashrc)
    const tmp = path.join(h.dir, "tmp")
    fs.mkdirSync(tmp)
    // Files past 64 blocks can't be written, so the new copy of the rc stops part-way.
    const r = await run(h, "uninstall.sh", { shell: "sh", wrap: 'trap "" XFSZ; ulimit -f 64;', extra: { TMPDIR: tmp } })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(`✗ Couldn't rewrite ${bashrc}, so it's as it was`)
    expect(r.out).not.toContain(`Removed the PATH line from ${bashrc}`)
    expect(fs.readFileSync(bashrc)).toEqual(before)
    expect(fs.readdirSync(tmp)).toEqual([])
  })

  test("leaves an rc file it can't write as it was, says so with ✗, and removes the rest", async () => {
    const h = makeHome()
    expect((await run(h, "install.sh")).code).toBe(0)
    const bashrc = path.join(h.home, ".bashrc")
    fs.chmodSync(bashrc, 0o444)
    const before = fs.readFileSync(bashrc)
    const r = await run(h, "uninstall.sh")
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(`✗ ${bashrc} isn't writable, so its PATH line stays. Take out this line yourself: case `)
    expect(fs.readFileSync(bashrc)).toEqual(before)
    expect(pathLines(path.join(h.home, ".profile"))).toBe(0)
    expect(fs.existsSync(h.wrapper)).toBe(false)
    expect(fs.existsSync(h.clone)).toBe(false)
  })

  test("leaves an opencorp it didn't write in place", async () => {
    const h = makeHome()
    writeScript(h.wrapper, "#!/bin/sh\necho mine\n")
    const r = await run(h, "uninstall.sh")
    expect(r.code).toBe(0)
    expect(r.out).toContain(`✓ Left ${h.wrapper} in place: install.sh did not write it.`)
    expect(fs.readFileSync(h.wrapper, "utf8")).toContain("echo mine")
  })

  test("keeps a clone with work that isn't anywhere else, whatever the user's git config, and says why", async () => {
    const changes = "it has changes or files that aren't committed"
    const commits = "it has commits that aren't pushed"
    const yian = (h: Home) => path.join(h.clone, "packages/yian")
    const work: [string, string, (h: Home) => void][] = [
      ["an untracked file", changes, (h) => fs.writeFileSync(path.join(h.clone, "draft"), "draft\n")],
      ["a commit on its branch", commits, (h) => commitFile(h.clone, "LOCAL")],
      [
        "a stash",
        "it has stashed changes",
        (h) => {
          fs.appendFileSync(path.join(h.clone, "package.json"), "\n")
          git(h.clone, "stash", "-q")
        },
      ],
      [
        "a commit on a detached HEAD",
        commits,
        (h) => {
          git(h.clone, "checkout", "-q", "--detach")
          commitFile(h.clone, "DETACHED")
        },
      ],
      [
        "a commit only a tag holds",
        commits,
        (h) => {
          git(h.clone, "checkout", "-q", "-b", "side")
          commitFile(h.clone, "TAGGED")
          git(h.clone, "tag", "kept")
          git(h.clone, "checkout", "-q", "main")
          git(h.clone, "branch", "-q", "-D", "side")
        },
      ],
      ["a linked worktree", "it has other worktrees", (h) => git(h.clone, "worktree", "add", "-q", "--detach", path.join(h.dir, "wt"))],
      [
        "a commit on a branch in the submodule, checked back out at the recorded commit",
        `its submodule packages/yian has commits that aren't pushed`,
        (h) => {
          const recorded = git(yian(h), "rev-parse", "HEAD")
          git(yian(h), "checkout", "-q", "-b", "side")
          commitFile(yian(h), "SIDE")
          git(yian(h), "checkout", "-q", "--detach", recorded)
        },
      ],
      [
        "a stash in the submodule",
        "its submodule packages/yian has stashed changes",
        (h) => {
          fs.appendFileSync(path.join(yian(h), "README"), "more\n")
          git(yian(h), "stash", "-q")
        },
      ],
      ["an untracked file in the submodule", changes, (h) => fs.writeFileSync(path.join(yian(h), "notes"), "notes\n")],
      [
        "an untracked file hidden by status.showUntrackedFiles=no",
        changes,
        (h) => {
          fs.writeFileSync(path.join(h.home, ".gitconfig"), "[status]\n\tshowUntrackedFiles = no\n")
          fs.writeFileSync(path.join(h.clone, "draft.md"), "draft\n")
        },
      ],
      [
        "a file a global excludes file hides",
        changes,
        (h) => {
          fs.writeFileSync(path.join(h.home, ".gitignore_global"), "notes/\n")
          fs.writeFileSync(path.join(h.home, ".gitconfig"), `[core]\n\texcludesFile = ${h.home}/.gitignore_global\n`)
          fs.mkdirSync(path.join(h.clone, "notes"))
          fs.writeFileSync(path.join(h.clone, "notes/todo.md"), "todo\n")
        },
      ],
      ["an ignored .env", changes, (h) => fs.writeFileSync(path.join(h.clone, ".env"), "KEY=secret\n")],
      [
        "ignored plans in docs/plans",
        changes,
        (h) => {
          fs.mkdirSync(path.join(h.clone, "docs/plans"), { recursive: true })
          fs.writeFileSync(path.join(h.clone, "docs/plans/design.md"), "plan\n")
        },
      ],
    ]
    for (const [what, why, make] of work) {
      const h = makeHome()
      expect((await run(h, "install.sh")).code).toBe(0)
      make(h)
      const r = await run(h, "uninstall.sh")
      expect(r.code, what).toBe(0)
      expect(r.err, what).toContain(`⚠ Left ${h.clone} in place: ${why}.`)
      expect(fs.existsSync(path.join(h.clone, ".git")), what).toBe(true)
      expect(fs.existsSync(h.wrapper), what).toBe(false)
    }
  })

  test("removes a clone whose only ignored files are what install makes: node_modules folders and HQ's build", async () => {
    const h = makeHome()
    expect((await run(h, "install.sh")).code).toBe(0)
    for (const dir of ["node_modules/.bin", "packages/cli/node_modules/x", "packages/app/dist/assets", "packages/yian/node_modules/y"]) {
      fs.mkdirSync(path.join(h.clone, dir), { recursive: true })
      fs.writeFileSync(path.join(h.clone, dir, "f"), "built\n")
    }
    const r = await run(h, "uninstall.sh")
    expect(r.err).not.toContain("Left")
    expect(r.code).toBe(0)
    expect(fs.existsSync(h.clone)).toBe(false)
  })

  test("keeps a checkout install.sh didn't clone, at --dir or the default", async () => {
    const h = makeHome()
    const mine = checkout(h, "mine")
    expect((await run(h, "install.sh", { from: mine })).code).toBe(0)
    const r = await run(h, "uninstall.sh", { args: ["--dir", mine] })
    expect(r.code).toBe(0)
    expect(r.out).toContain(`✓ Left ${mine} in place: install.sh did not clone it.`)
    expect(fs.existsSync(path.join(mine, "package.json"))).toBe(true)
    expect(fs.existsSync(h.wrapper)).toBe(false)

    const other = makeHome()
    git(other.dir, "clone", "-q", source, other.clone)
    const byDefault = await run(other, "uninstall.sh")
    expect(byDefault.out).toContain(`✓ Left ${other.clone} in place: install.sh did not clone it.`)
  })

  test("removes the clone at --dir that install.sh made there", async () => {
    const h = makeHome()
    const dir = path.join(h.home, "apps", "opencorp")
    expect((await run(h, "install.sh", { args: ["--dir", dir] })).code).toBe(0)
    const r = await run(h, "uninstall.sh", { args: ["--dir", dir] })
    expect(r.code).toBe(0)
    expect(fs.existsSync(dir)).toBe(false)
  })

  test("with an office set up and no terminal, it stops and changes nothing", async () => {
    for (const state of ["office", "identity.json"]) {
      const h = makeHome()
      expect((await run(h, "install.sh")).code).toBe(0)
      fs.mkdirSync(h.office, { recursive: true })
      fs.writeFileSync(path.join(h.office, state), "")
      const rc = fs.readFileSync(path.join(h.home, ".bashrc"), "utf8")
      const r = await run(h, "uninstall.sh")
      expect(r.code).not.toBe(0)
      expect(r.err).toContain(`✗ An office is set up at ${h.office}. Run opencorp offboard on a terminal first`)
      expect(fs.existsSync(h.wrapper)).toBe(true)
      expect(fs.existsSync(h.clone)).toBe(true)
      expect(fs.readFileSync(path.join(h.home, ".bashrc"), "utf8")).toBe(rc)
      expect(calls(h).filter((c) => c.includes("offboard"))).toEqual([])
    }
  })

  test("a company repo offboard kept is no office, so it doesn't stop the uninstall", async () => {
    const h = makeHome()
    expect((await run(h, "install.sh")).code).toBe(0)
    fs.mkdirSync(path.join(h.office, "company"), { recursive: true })
    const r = await run(h, "uninstall.sh")
    expect(r.code).toBe(0)
    expect(fs.existsSync(h.wrapper)).toBe(false)
    expect(fs.existsSync(path.join(h.office, "company"))).toBe(true)
  })

  describe.skipIf(!TMUX)("on a terminal", () => {
    test("with an office set up, it runs opencorp offboard on the terminal first, then removes the rest", async () => {
      const h = makeHome()
      expect((await run(h, "install.sh")).code).toBe(0)
      fs.mkdirSync(path.join(h.office, "office"), { recursive: true })
      const t = onTerminal(h, "uninstall.sh")
      expect(await t.exit()).toBe(0)
      expect(t.screen()).toContain(`→ An office is set up at ${h.office}; running opencorp offboard first`)
      expect(calls(h).filter((c) => c.includes("main.ts offboard |"))).toEqual([
        `${path.join(bunDir, "bun")} --no-install --no-env-file --config=/dev/null ${h.clone}/packages/cli/src/main.ts offboard | ${h.home} | tty`,
      ])
      expect(fs.existsSync(h.wrapper)).toBe(false)
      expect(fs.existsSync(h.clone)).toBe(false)
    })

    test("when offboard doesn't finish, it stops and changes nothing", async () => {
      const h = makeHome()
      expect((await run(h, "install.sh")).code).toBe(0)
      fs.mkdirSync(path.join(h.office, "office"), { recursive: true })
      const t = onTerminal(h, "uninstall.sh", { extra: { STUB_OFFBOARD_FAILS: "1" } })
      expect(await t.exit()).toBe(1)
      expect(t.screen()).toContain("✗ opencorp offboard didn't finish, so nothing else was removed.")
      expect(fs.existsSync(h.wrapper)).toBe(true)
      expect(fs.existsSync(h.clone)).toBe(true)
      expect(pathLines(path.join(h.home, ".bashrc"))).toBe(1)
    })
  })
})

describe("both scripts", () => {
  for (const shell of SHELLS) {
    test(`under ${shell}, a piped install and uninstall leave the home as it was`, async () => {
      const h = makeHome()
      fs.writeFileSync(path.join(h.home, ".bashrc"), "alias ll='ls -l'\n")
      const installed = await run(h, "install.sh", { shell })
      expect(installed.err).not.toContain("✗")
      expect(installed.code).toBe(0)
      expect(fs.existsSync(path.join(h.clone, ".git/opencorp-installer"))).toBe(true)
      const removed = await run(h, "uninstall.sh", { shell })
      expect(removed.err).not.toContain("✗")
      expect(removed.code).toBe(0)
      expect(fs.readFileSync(path.join(h.home, ".bashrc"), "utf8")).toBe("alias ll='ls -l'\n")
      expect(fs.existsSync(h.wrapper)).toBe(false)
      expect(fs.existsSync(h.clone)).toBe(false)
    })
  }

  test.skipIf(!process.env.OPENCORP_TEST_INSTALL)(
    "piped, installs a clone of this checkout with the real Bun, offline, and opencorp --help runs",
    async () => {
      const h = makeHome()
      const branch = git(CHECKOUT, "symbolic-ref", "--short", "HEAD")
      const cache = process.env.BUN_INSTALL_CACHE_DIR ?? path.join(os.homedir(), ".bun", "install", "cache")
      // Anything that tries the network gets a proxy that refuses at once.
      const offline = "http://127.0.0.1:9"
      const extra = {
        PATH: `${path.dirname(process.execPath)}:${stubs}:${SYSTEM}`,
        BUN_INSTALL_CACHE_DIR: cache,
        HTTP_PROXY: offline,
        HTTPS_PROXY: offline,
        http_proxy: offline,
        https_proxy: offline,
        ...gitConfig([["https://github.com/ngocbh/yian.git", path.join(CHECKOUT, "packages/yian")]]),
      }
      const stdin = fs.openSync(path.join(CHECKOUT, "install.sh"), "r")
      const child = spawn("sh", ["-s", "--", "--repo", CHECKOUT, "--branch", branch, "--skip-setup"], {
        cwd: h.home,
        env: env(h, extra),
        detached: true,
        stdio: [stdin, "pipe", "pipe"],
      })
      fs.closeSync(stdin)
      let out = ""
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (out += chunk))
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (out += chunk))
      const timer = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 560_000)
      const code = await new Promise<number | null>((resolve) => child.on("close", (status) => resolve(status)))
      clearTimeout(timer)
      expect(out).not.toContain("✗")
      expect(code).toBe(0)
      expect(calls(h)).toEqual([])
      const help = spawnSync(h.wrapper, ["--help"], { env: { PATH: SYSTEM, HOME: h.home }, encoding: "utf8", timeout: 60_000 })
      expect(help.stderr).toBe("")
      expect(help.status).toBe(0)
      expect(help.stdout).toContain("opencorp")
      // The build leaves the clone clean, so the next run can update it.
      expect(git(h.clone, "status", "--porcelain")).toBe("")
    },
    600_000,
  )
})
