/** The terminal's prompt guards: what only the owner may answer. */
import { expect, test } from "bun:test"
import { ownerPrompt } from "../../../src/tools/terminal/guards.ts"

/** A shell at its prompt, or a local program reading a line with echo on. */
const LINES = { echo: true, canonical: true }
/** A local password read: whole lines, echo off. */
const SECRET = { echo: false, canonical: true }
/** Raw: inside an ssh session, or a full-screen program. */
const RAW = { echo: false, canonical: false }

test("echo off with whole lines is a secret prompt, whatever it says", () => {
  for (const line of ["", "nhb25@misha's password: ", "Enter a name: ", "Login incorrect", "> "])
    expect(ownerPrompt(line, SECRET)).toBe("secret")
})

test("a remote password, passphrase, PIN, OTP, token or one-time code prompt is a secret prompt, and so is a bare Response:", () => {
  const prompts = [
    "nhb25@misha.ycrc.yale.edu's password: ",
    "(nhb25@misha) Password:",
    "[sudo] password for nhb25: ",
    "Password for 'https://github.com':",
    "Enter passphrase for key '/home/nhb25/.ssh/id_ed25519': ",
    "Enter PIN for 'PIV Card Holder pin (PIV_II)': ",
    "Enter your pin:",
    "OTP: ",
    "GitHub token:\t",
    "One-time code: ",
    "One-time password (OATH) for `nhb25': ",
    "Verification code: ",
    "Response: ",
    "response:",
    "  Response:",
  ]
  for (const line of prompts) {
    expect(ownerPrompt(line, RAW), line).toBe("secret")
    expect(ownerPrompt(line, LINES), line).toBe("secret")
  }
})

test("ssh's host key question is not the owner's alone", () => {
  const screen =
    "The authenticity of host 'misha (10.0.0.1)' can't be established.\n" +
    "ED25519 key fingerprint is SHA256:fake.\n" +
    "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
  for (const modes of [LINES, RAW]) {
    expect(ownerPrompt(screen, modes)).toBeNull()
    expect(ownerPrompt("Are you sure you want to continue connecting (yes/no/[fingerprint])? ", modes)).toBeNull()
    expect(ownerPrompt("Please type 'yes', 'no' or the fingerprint: ", modes)).toBeNull()
  }
})

test("Duo's passcode-or-option prompt is not the owner's alone", () => {
  const screen =
    "Duo two-factor login for nhb25\n\n" +
    "Enter a passcode or select one of the following options:\n\n" +
    " 1. Duo Push to XXX-XXX-1234\n\n" +
    "Passcode or option (1-3): "
  for (const modes of [LINES, RAW]) {
    expect(ownerPrompt(screen, modes)).toBeNull()
    expect(ownerPrompt("Passcode or option (1-3): ", modes)).toBeNull()
  }
})

test("a full-screen program's raw mode is not a secret prompt", () => {
  for (const line of ["", "~", "-- INSERT --", "top - 10:00:00 up 5 days,  2 users,  load average: 0.10", "MiB Mem :  1234.5 total"])
    expect(ownerPrompt(line, RAW)).toBeNull()
  expect(ownerPrompt("", { echo: true, canonical: false })).toBeNull()
})

test("a prompt in the middle of the output doesn't count, only the last line", () => {
  expect(ownerPrompt("nhb25@misha's password: \nPermission denied, please try again.\n", LINES)).toBeNull()
  expect(ownerPrompt("Password: \nwelcome to misha\n$ ", RAW)).toBeNull()
  expect(ownerPrompt("Permission denied (publickey,password).", LINES)).toBeNull()
  expect(ownerPrompt("Password:\n", RAW)).toBeNull()
  expect(ownerPrompt("welcome\nnhb25@misha's password: ", RAW)).toBe("secret")
})

test("a long last line is checked in linear time, since a command's output picks it", () => {
  const line = "token ".repeat(200_000)
  const started = performance.now()
  expect(ownerPrompt(line, RAW)).toBeNull()
  expect(ownerPrompt(`${line}:`, RAW)).toBe("secret")
  expect(performance.now() - started).toBeLessThan(1000)
})
