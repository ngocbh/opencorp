/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TuiKeybind } from "../src/config/keybind"
import {
  formatKeySequence,
  getOpenCorpModeStack,
  OPENCORP_BASE_MODE,
  OpenCorpKeymapProvider,
  registerOpenCorpKeymap,
} from "../src/keymap"

function createResolvedKeymapConfig(input: TuiKeybind.KeybindOverrides = {}) {
  const keybinds = TuiKeybind.parse(input)
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

test("legacy page key aliases compile as page keys", async () => {
  const sequences: Record<string, string[][]> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig({
      messages_page_up: "pgup",
      messages_page_down: "pgdown",
    })
    const offKeymap = registerOpenCorpKeymap(keymap, renderer, config)
    const offLayer = keymap.registerLayer({
      bindings: config.keybinds.gather("session", ["session.page.up", "session.page.down"]),
    })
    const bindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: ["session.page.up", "session.page.down"],
    })
    sequences.up =
      bindings.get("session.page.up")?.map((binding) => binding.sequence.map((part) => part.stroke.name)) ?? []
    sequences.down =
      bindings.get("session.page.down")?.map((binding) => binding.sequence.map((part) => part.stroke.name)) ?? []
    onCleanup(() => {
      offLayer()
      offKeymap()
    })

    return (
      <OpenCorpKeymapProvider keymap={keymap}>
        <box />
      </OpenCorpKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(sequences).toEqual({
      up: [["pageup"]],
      down: [["pagedown"]],
    })
  } finally {
    app.renderer.destroy()
  }
})

test("mode-less bindings stay active when the mode changes", async () => {
  const counts: Record<string, Record<string, number>> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig()
    const offKeymap = registerOpenCorpKeymap(keymap, renderer, config)
    const offGlobal = keymap.registerLayer({
      commands: [
        { name: "session.list", run() {} },
        { name: "session.new", run() {} },
        { name: "session.page.up", run() {} },
        { name: "session.first", run() {} },
      ],
      bindings: config.keybinds.gather("test.global", [
        "session.list",
        "session.new",
        "session.page.up",
        "session.first",
      ]),
    })
    const offBase = keymap.registerLayer({
      mode: OPENCORP_BASE_MODE,
      commands: [{ name: "agent.cycle", run() {} }],
      bindings: config.keybinds.gather("test.base", ["agent.cycle"]),
    })
    const activeCounts = () =>
      Object.fromEntries(
        Array.from(
          keymap.getCommandBindings({
            visibility: "active",
            commands: ["session.list", "session.new", "session.page.up", "session.first", "agent.cycle"],
          }),
          ([command, bindings]) => [command, bindings.length],
        ),
      )

    counts.base = activeCounts()
    const popQuestion = getOpenCorpModeStack(keymap).push("question")
    counts.question = activeCounts()
    popQuestion()
    const popAutocomplete = getOpenCorpModeStack(keymap).push("autocomplete")
    counts.autocomplete = activeCounts()
    popAutocomplete()

    onCleanup(() => {
      offBase()
      offGlobal()
      offKeymap()
    })

    return (
      <OpenCorpKeymapProvider keymap={keymap}>
        <box />
      </OpenCorpKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(counts).toEqual({
      base: { "session.list": 1, "session.new": 1, "session.page.up": 2, "session.first": 2, "agent.cycle": 1 },
      question: { "session.list": 1, "session.new": 1, "session.page.up": 2, "session.first": 2, "agent.cycle": 0 },
      autocomplete: {
        "session.list": 1,
        "session.new": 1,
        "session.page.up": 2,
        "session.first": 2,
        "agent.cycle": 0,
      },
    })
  } finally {
    app.renderer.destroy()
  }
})

test("the picker's keys are the upstream TUI's: ↓ toggles it, ↑ goes to the parent, and its rows take ↑/↓, Enter and ctrl+d", () => {
  const config = createResolvedKeymapConfig()
  const keys = (command: string) => config.keybinds.get(command).map((binding) => binding.key)
  expect(keys("session.child.first")).toEqual(["down"])
  expect(keys("session.parent")).toEqual(["up"])
  expect(["up", "down", "select", "interrupt"].map((key) => keys(`composer.subagent.${key}`))).toEqual([
    ["up"],
    ["down"],
    ["return"],
    ["ctrl+d"],
  ])
  expect(["up", "down", "select", "kill"].map((key) => keys(`composer.shell.${key}`))).toEqual([
    ["up"],
    ["down"],
    ["return"],
    ["ctrl+d"],
  ])
  // The old footer's Next and Prev are gone, with their config names.
  expect(keys("session.child.next")).toEqual([])
  expect(keys("session.child.previous")).toEqual([])
  expect(TuiKeybind.unknownKeys({ session_child_cycle: "none", session_child_cycle_reverse: "none" })).toHaveLength(2)
})

test("Esc, Ctrl+C and ↑ in a chat are Claude Code's keys: Esc interrupts, Ctrl+C interrupts or clears, then leaves", () => {
  const config = createResolvedKeymapConfig()
  const keys = (command: string) => config.keybinds.get(command).map((binding) => binding.key)
  // Esc interrupts while the employee works or waits; idle, the prompt's own Esc Esc clears a draft.
  expect(keys("session.interrupt")).toEqual(["escape"])
  // Ctrl+C interrupts while they work, else clears the draft; on an empty prompt it is the first of the leave keys.
  expect(keys("prompt.clear")).toEqual(["ctrl+c"])
  expect(keys("app.exit")).toEqual(["ctrl+c,ctrl+d,<leader>q"])
  expect(config.keybinds.get("prompt.clear")[0]?.desc).toBe("Interrupt the session, or clear the input field")
  // ↑ takes back unread messages first, then walks the history.
  expect(keys("prompt.history.previous")).toEqual(["up"])
  // Nothing has Claude Code's ctrl+x ctrl+k yet.
  expect(config.keybinds.bindings.filter((binding) => binding.key === "<leader>ctrl+k")).toEqual([])
})

test("the pane's keys are the upstream TUI's: ctrl+x ←/→ move the keys, ctrl+x ↑ closes it and ctrl+x ↓ opens the picker; ctrl+x f shows it split or full", () => {
  const config = createResolvedKeymapConfig()
  const keys = (command: string) => config.keybinds.get(command).map((binding) => binding.key)
  expect(keys("pane.focus.left")).toEqual(["<leader>left"])
  expect(keys("pane.focus.right")).toEqual(["<leader>right"])
  expect(keys("pane.close")).toEqual(["<leader>up"])
  expect(keys("pane.select")).toEqual(["<leader>down"])
  // Upstream's panel full screen is the diff's bare `f`; a pane that takes typing would take that, so it follows the
  // leader.
  expect(keys("pane.fullscreen")).toEqual(["<leader>f"])
  // Esc closes only a pane that takes no typing.
  expect(keys("pane.dismiss")).toEqual(["escape"])
  // Split or full is one entry, so its key changes in one place.
  const moved = createResolvedKeymapConfig({ "pane.fullscreen": "<leader>o" })
  expect(moved.keybinds.get("pane.fullscreen").map((binding) => binding.key)).toEqual(["<leader>o"])
  // The old instrument commands are gone, with their config names.
  expect(keys("session.instrument.cycle")).toEqual([])
  expect(
    TuiKeybind.unknownKeys({
      session_instrument_cycle: "none",
      session_instrument_close: "none",
      session_instrument_focus_chat: "none",
      session_instrument_focus: "none",
    }),
  ).toHaveLength(4)
})

test("arrow keys show as arrows, as the upstream TUI shows them", async () => {
  const shown: Record<string, string> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig()
    const offKeymap = registerOpenCorpKeymap(keymap, renderer, config)
    const commands = ["session.child.first", "session.parent", "pane.focus.left", "pane.close"]
    const offLayer = keymap.registerLayer({
      commands: commands.map((name) => ({ name, run() {} })),
      bindings: config.keybinds.gather("test", commands),
    })
    const bindings = keymap.getCommandBindings({ visibility: "registered", commands })
    for (const command of commands) shown[command] = formatKeySequence(bindings.get(command)?.[0]?.sequence, config)
    onCleanup(() => {
      offLayer()
      offKeymap()
    })

    return (
      <OpenCorpKeymapProvider keymap={keymap}>
        <box />
      </OpenCorpKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(shown).toEqual({
      "session.child.first": "↓",
      "session.parent": "↑",
      "pane.focus.left": "ctrl+x ←",
      "pane.close": "ctrl+x ↑",
    })
  } finally {
    app.renderer.destroy()
  }
})
