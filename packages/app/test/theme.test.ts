import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const SOURCE = readFileSync(path.join(import.meta.dir, "../public/theme.js"), "utf8")

/** Runs public/theme.js against `storage` and a system that prefers dark or not; returns the theme it sets. */
function theme(storage: { getItem: (k: string) => string | null }, prefersDark: boolean) {
  const document = { documentElement: { dataset: {} as Record<string, string> } }
  const matchMedia = (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" && prefersDark })
  new Function("localStorage", "matchMedia", "document", SOURCE)(storage, matchMedia, document)
  return document.documentElement.dataset.theme
}

test("a saved theme wins; without one the system's preference decides", () => {
  expect(theme({ getItem: () => "light" }, true)).toBe("light")
  expect(theme({ getItem: () => "dark" }, false)).toBe("dark")
  expect(theme({ getItem: () => null }, true)).toBe("dark")
  expect(theme({ getItem: () => null }, false)).toBe("light")
})

test("blocked storage falls back to the system's preference", () => {
  const blocked = {
    getItem: () => {
      throw new DOMException("denied", "SecurityError")
    },
  }
  expect(theme(blocked, true)).toBe("dark")
})
