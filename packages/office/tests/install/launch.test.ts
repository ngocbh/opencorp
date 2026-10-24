/** How the office daemon is started: its environment. */
import { expect, test } from "bun:test"
import { daemonEnv } from "../../src/install/launch.ts"
import { unsafeEnvName } from "../../src/platform.ts"

test("the daemon gets only the worker allowlist never keys", () => {
  const environ = {
    PATH: "/usr/bin",
    HOME: "/Users/owner",
    LC_ALL: "C",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp",
    OPENCORP_HOME: "/x",
    // iTerm's, which change with its version: they'd rewrite the service file for nothing.
    LC_TERMINAL: "iTerm2",
    LC_TERMINAL_VERSION: "3.5.0",
  }
  expect(daemonEnv(environ)).toEqual({ PATH: "/usr/bin", HOME: "/Users/owner", LC_ALL: "C", LANG: "en_US.UTF-8" })
})

test("the daemon keeps which codex to run and its home", () => {
  const environ = {
    PATH: "/usr/bin",
    CODEX_HOME: "/Users/owner/.codex-alt",
    OPENCORP_CODEX_BIN: "/opt/codex",
    OPENAI_API_KEY: "sk-secret",
  }
  expect(daemonEnv(environ)).toEqual({
    PATH: "/usr/bin",
    CODEX_HOME: "/Users/owner/.codex-alt",
    OPENCORP_CODEX_BIN: "/opt/codex",
  })
})

test("the daemon keeps where tls finds ca certificates when set", () => {
  const environ = {
    PATH: "/usr/bin",
    SSL_CERT_FILE: "/etc/pki/tls/certs/ca-bundle.crt",
    SSL_CERT_DIR: "/etc/pki/tls/certs",
    REQUESTS_CA_BUNDLE: "/ca.pem",
  }
  expect(daemonEnv(environ)).toEqual({
    PATH: "/usr/bin",
    SSL_CERT_FILE: "/etc/pki/tls/certs/ca-bundle.crt",
    SSL_CERT_DIR: "/etc/pki/tls/certs",
  })
  expect(daemonEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" })
})

test("the daemon path keeps only absolute entries", () => {
  const mixed = { PATH: "/usr/bin::bin:./x:/opt/b/../c:", HOME: "/Users/owner" }
  expect(daemonEnv(mixed)).toEqual({ PATH: "/usr/bin:/opt/b/../c", HOME: "/Users/owner" })
  const relative = { PATH: "bin:.", HOME: "/Users/owner" }
  expect(daemonEnv(relative)).toEqual({ HOME: "/Users/owner" })
  for (const environ of [mixed, relative]) expect(daemonEnv(daemonEnv(environ))).toEqual(daemonEnv(environ))
})

test("the daemon env leaves out every name a self spawn may not carry", () => {
  const environ = {
    PATH: "/usr/bin",
    BUN_OPTIONS: "--preload=/tmp/x.ts",
    NODE_OPTIONS: "--require=/tmp/x.js",
    LD_PRELOAD: "/tmp/x.so",
    DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
    NODE_PATH: "/tmp/mods",
  }
  const env = daemonEnv(environ)
  expect(env).toEqual({ PATH: "/usr/bin" })
  for (const key of Object.keys(env)) expect(unsafeEnvName(key)).toBe(false)
})
