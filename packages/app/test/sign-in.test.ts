import { expect, test } from "bun:test"
import { OfficeError, OfficeTimeout, OfficeUnavailable } from "@opencorp/client"
import { browserLabel, cleanHandle, signInFailure } from "../src/data/sign-in"

test("a handle is trimmed, loses one leading @, and is lowercased", () => {
  expect(cleanHandle("  @NgocBH ")).toBe("ngocbh")
  expect(cleanHandle("ann")).toBe("ann")
  expect(cleanHandle("@@ann")).toBe("@ann") // only one: the office then refuses it like any other wrong handle
})

test("the browser's label names the browser and the system", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
  expect(browserLabel(`${mac} Version/18.0 Safari/605.1.15`)).toBe("Safari on Mac")
  expect(browserLabel(`${mac} Chrome/140.0 Safari/537.36`)).toBe("Chrome on Mac")
  expect(browserLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0")).toBe("Edge on Windows")
  expect(browserLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on Linux")
  expect(browserLabel("curl/8")).toBe("A browser on this device")
})

const err = (status: number, code: string, retryAfterS?: number) =>
  Object.assign(new OfficeError(status, code, code), { retryAfterS })

test("a wrong handle or password, or one the office can't read, says so the same way", () => {
  expect(signInFailure(err(401, "bad_credentials"))).toBe("Wrong handle or password.")
  expect(signInFailure(err(422, "invalid_body"))).toBe("Wrong handle or password.")
})

test("too many tries says how long to wait, in whole minutes rounded up, and offers pairing", () => {
  expect(signInFailure(err(429, "too_many_attempts", 600))).toBe(
    "Too many tries; wait 10 minutes, or run `opencorp pair`.",
  )
  expect(signInFailure(err(429, "too_many_attempts", 61))).toBe("Too many tries; wait 2 minutes, or run `opencorp pair`.")
  expect(signInFailure(err(429, "too_many_attempts", 5))).toBe("Too many tries; wait 1 minute, or run `opencorp pair`.")
  expect(signInFailure(err(429, "too_many_attempts"))).toBe(
    "Too many tries; wait a few minutes, or run `opencorp pair`.",
  )
})

test("a busy office says to try again", () => {
  expect(signInFailure(err(503, "busy"))).toBe("The office is busy; try again.")
})

test("anything else, an unreachable office included, says what went wrong as the pair page does", () => {
  const down = new OfficeUnavailable("/api", undefined, true)
  expect(signInFailure(down)).toBe(`Couldn't sign in: ${down.message}.`)
  const slow = new OfficeTimeout("POST", "/login", 1000)
  expect(signInFailure(slow)).toBe(`Couldn't sign in: ${slow.message}.`)
  expect(signInFailure(new OfficeError(500, "internal", "it broke"))).toBe("Couldn't sign in: it broke.")
  expect(signInFailure("odd")).toBe("Couldn't sign in: odd.")
})
