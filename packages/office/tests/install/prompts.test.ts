/** How onboarding and `opencorp hq` show text from programs and models. */
import { expect, test } from "bun:test"
import { clean } from "../../src/install/prompts.ts"

test("clean shows bidi controls and other invisible format characters escaped", () => {
  expect(clean("a‪b‮c⁦d⁩e")).toBe("a<U+202A>b<U+202E>c<U+2066>d<U+2069>e")
  expect(clean("x​y‍z﻿­؜")).toBe("x<U+200B>y<U+200D>z<U+FEFF><U+00AD><U+061C>")
  expect(clean("\u{e0041}")).toBe("<U+E0041>")
  // Line breaks still become spaces, and other control characters still go.
  expect(clean("a\nb\x1b[2Jc")).toBe("a b[2Jc")
})
