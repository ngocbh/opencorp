/** The environment a run worker starts with. */
import { expect, test } from "bun:test"
import { INHERITED_ENV as LAUNCH_ENV } from "../../src/install/launch.ts"
import { INHERITED_ENV, workerEnv } from "../../src/worker/spawn.ts"

test("a worker keeps where tls finds ca certificates when the office has it", () => {
  const env = workerEnv({
    PATH: "/bin",
    SSL_CERT_FILE: "/etc/pki/tls/certs/ca-bundle.crt",
    SSL_CERT_DIR: "/etc/pki/tls/certs",
  })
  expect(env.SSL_CERT_FILE).toBe("/etc/pki/tls/certs/ca-bundle.crt")
  expect(env.SSL_CERT_DIR).toBe("/etc/pki/tls/certs")
  const without = workerEnv({ PATH: "/bin", SSL_CERT_FILE: undefined })
  expect("SSL_CERT_FILE" in without).toBe(false)
  expect("SSL_CERT_DIR" in without).toBe(false)
})

test("worker env narrows the environment it is given", () => {
  const environ = { PATH: "/bin", LC_ALL: "C", SSL_CERT_FILE: "/ca.pem", OPENAI_API_KEY: "sk-secret" }
  expect(workerEnv(environ)).toEqual({ PATH: "/bin", LC_ALL: "C", SSL_CERT_FILE: "/ca.pem" })
})

test("the worker env names are the launch allowlist", () => {
  expect(INHERITED_ENV).toBe(LAUNCH_ENV)
  expect([...INHERITED_ENV]).toEqual([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "TMPDIR",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])
})
