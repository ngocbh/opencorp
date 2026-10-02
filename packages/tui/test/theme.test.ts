import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TerminalColors } from "@opentui/core"
import {
  DEFAULT_THEME,
  DEFAULT_THEMES,
  RENAMED_THEMES,
  allThemes,
  hasTheme,
  resolveTheme,
  setCustomThemes,
  terminalMode,
  themeName,
} from "../src/theme"
import { discoverThemes } from "../src/context/theme"
import { tmpdir } from "./fixture/fixture"

test("hasTheme checks built-in and custom themes", () => {
  const name = `custom-theme-has-${Date.now()}`
  expect(hasTheme(DEFAULT_THEME)).toBe(true)
  expect(hasTheme(name)).toBe(false)
  setCustomThemes({ [name]: DEFAULT_THEMES[DEFAULT_THEME] })
  expect(hasTheme(name)).toBe(true)
  expect(allThemes()[name]).toBeDefined()
  setCustomThemes({})
  expect(hasTheme(name)).toBe(false)
})

test("a theme chosen under an old name loads as the theme it became", () => {
  for (const [old, now] of Object.entries(RENAMED_THEMES)) {
    expect(hasTheme(old)).toBe(false)
    expect(themeName(old)).toBe(now)
    expect(hasTheme(now)).toBe(true)
  }
  expect(themeName("nord")).toBe("nord")
})

test("resolveTheme rejects circular color refs", () => {
  const item = structuredClone(DEFAULT_THEMES[DEFAULT_THEME])
  item.defs = { ...item.defs, one: "two", two: "one" }
  item.theme.primary = "one"
  expect(() => resolveTheme(item, "dark")).toThrow("Circular color reference")
})

function terminalColors(defaultBackground: string | null, palette: Array<string | null> = []): TerminalColors {
  return {
    palette,
    defaultForeground: null,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("terminalMode derives mode from refreshed background", () => {
  expect(terminalMode(terminalColors("#fbf1c7"))).toBe("light")
  expect(terminalMode(terminalColors("#1a1b26"))).toBe("dark")
})

test("terminalMode does not derive mode from ANSI slot zero", () => {
  expect(terminalMode(terminalColors(null, ["#000000"]))).toBeUndefined()
})

test("custom theme precedence follows directory order", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "project")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "custom.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, "themes", "custom.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes([global, project])).resolves.toEqual({ custom: { source: "project" } })
})
