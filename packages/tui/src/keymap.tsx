import { InputRenderable, TextareaRenderable, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core"
import {
  registerBackspacePopsPendingSequence,
  registerBaseLayoutFallback,
  registerCommaBindings,
  registerEscapeClearsPendingSequence,
  registerManagedTextareaLayer,
  registerTimedLeader,
} from "@opentui/keymap/addons/opentui"
import { stringifyKeyStroke, type Binding } from "@opentui/keymap"
import {
  formatCommandBindings as formatCommandBindingsExtra,
  formatKeySequence as formatKeySequenceExtra,
} from "@opentui/keymap/extras"
import { KeymapProvider, useKeymap, useKeymapSelector, useBindings } from "@opentui/keymap/solid"
import { createMemo, type Accessor } from "solid-js"
import { useTuiConfig } from "./config"
import { TuiKeybind } from "./config/keybind"

export const LEADER_TOKEN = "leader"
export const AGENT_CORP_BASE_MODE = "base"
export const COMMAND_PALETTE_COMMAND = "command.palette.show"

const AGENT_CORP_MODE_KEY = "agentcorp.mode"

export const AgentCorpKeymapProvider = KeymapProvider
export const useAgentCorpKeymap = useKeymap

export { useBindings, useKeymapSelector }

export type OpenTuiKeymap = ReturnType<typeof useKeymap>
type AgentCorpModeStack = ReturnType<typeof createAgentCorpModeStack>
type CommandSlashEntry = {
  display: string
  description?: string
  aliases?: string[]
  onSelect: () => void
}
type Command = ReturnType<OpenTuiKeymap["getCommands"]>[number]
type BindingLookup = {
  get(command: string): readonly Binding<Renderable, KeyEvent>[]
  gather(name: string, commands: readonly string[]): readonly Binding<Renderable, KeyEvent>[]
}
type FormatConfig = { keybinds: BindingLookup }
type ResolvedKeymapConfig = FormatConfig & { leader_timeout: number }

const modeStacks = new WeakMap<OpenTuiKeymap, AgentCorpModeStack>()

function isVisiblePaletteCommand(command: Command) {
  return command.hidden !== true && command.name !== COMMAND_PALETTE_COMMAND
}

export function createAgentCorpModeStack(keymap: OpenTuiKeymap) {
  keymap.setData(AGENT_CORP_MODE_KEY, AGENT_CORP_BASE_MODE)

  const offFields = keymap.registerLayerFields({
    mode(value, ctx) {
      ctx.require(AGENT_CORP_MODE_KEY, value)
    },
  })

  const stack: { id: symbol; mode: string }[] = []
  let disposed = false

  const update = () => {
    keymap.setData(AGENT_CORP_MODE_KEY, stack.at(-1)?.mode ?? AGENT_CORP_BASE_MODE)
  }

  const stackApi = {
    current() {
      return stack.at(-1)?.mode ?? AGENT_CORP_BASE_MODE
    },
    push(mode: string) {
      if (disposed) return () => {}
      const id = Symbol(mode)
      let active = true
      stack.push({ id, mode })
      update()

      return () => {
        if (!active) return
        active = false
        const index = stack.findIndex((item) => item.id === id)
        if (index !== -1) stack.splice(index, 1)
        update()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      stack.length = 0
      offFields()
      keymap.setData(AGENT_CORP_MODE_KEY, undefined)
      modeStacks.delete(keymap)
    },
  }

  modeStacks.set(keymap, stackApi)
  return stackApi
}

export function useAgentCorpModeStack() {
  return getAgentCorpModeStack(useAgentCorpKeymap())
}

export function getAgentCorpModeStack(keymap: OpenTuiKeymap) {
  const value = modeStacks.get(keymap)
  if (!value) throw new Error("Mode stack is not registered for this keymap")
  return value
}

const KEY_ALIASES = {
  enter: "return",
  esc: "escape",
  pgdown: "pagedown",
  pgup: "pageup",
} as const

function expandKeyAliases(input: string) {
  const result = Object.entries(KEY_ALIASES).reduce(
    (acc, [alias, key]) => acc.replace(new RegExp(`(^|[+,\\s>])${alias}(?=$|[+,\\s<])`, "gi"), `$1${key}`),
    input,
  )
  if (result === input) return
  return result
}

function registerKeyAliases(keymap: OpenTuiKeymap) {
  return keymap.appendBindingExpander((ctx) => {
    const key = expandKeyAliases(ctx.input)
    if (!key) return
    return [{ key, displays: ctx.displays }]
  })
}

const inputCommands = [
  "input.move.left",
  "input.move.right",
  "input.move.up",
  "input.move.down",
  "input.select.left",
  "input.select.right",
  "input.select.up",
  "input.select.down",
  "input.line.home",
  "input.line.end",
  "input.select.line.home",
  "input.select.line.end",
  "input.visual.line.home",
  "input.visual.line.end",
  "input.select.visual.line.home",
  "input.select.visual.line.end",
  "input.buffer.home",
  "input.buffer.end",
  "input.select.buffer.home",
  "input.select.buffer.end",
  "input.delete.line",
  "input.delete.to.line.end",
  "input.delete.to.line.start",
  "input.backspace",
  "input.delete",
  "input.newline",
  "input.undo",
  "input.redo",
  "input.word.forward",
  "input.word.backward",
  "input.select.word.forward",
  "input.select.word.backward",
  "input.delete.word.forward",
  "input.delete.word.backward",
  "input.select.all",
  "input.submit",
] as const

function hasManagedTextareaFocus(renderer: CliRenderer) {
  const editor = renderer.currentFocusedEditor
  return editor instanceof TextareaRenderable && !(editor instanceof InputRenderable)
}

function leaderDisplay(config: FormatConfig) {
  const key = config.keybinds.get(LEADER_TOKEN)?.[0]?.key
  if (!key) return TuiKeybind.LeaderDefault
  return typeof key === "string" ? key : stringifyKeyStroke(key)
}

function leaderKey(config: FormatConfig) {
  return config.keybinds.get(LEADER_TOKEN)?.[0]?.key
}

function formatOptions(config: FormatConfig) {
  return {
    tokenDisplay: {
      [LEADER_TOKEN]: leaderDisplay(config),
    },
    keyNameAliases: {
      pageup: "pgup",
      pagedown: "pgdn",
      delete: "del",
    },
    modifierAliases: {
      meta: "alt",
    },
  } as const
}

/**
 * The clear keys (`keys`, the `input_clear` bindings, Ctrl+C by default) and Esc bound to `clear`, which empties
 * a typing box and returns true, or returns false when there is nothing to clear. With `input_clear` turned off,
 * only Esc clears.
 */
export function clearFirst(
  keys: readonly Binding<Renderable, KeyEvent>[],
  clear: () => boolean,
): Binding<Renderable, KeyEvent>[] {
  // The keymap takes false as unhandled: it tries the key's next binding, then lets the key through to
  // useKeyboard. Any other return, undefined too, handles the key and stops it, so `clear` returns a strict boolean.
  return [...keys, { key: "escape" }].map((b) => ({ ...b, desc: "Clear the box", group: "Input", cmd: clear }))
}

export function formatKeySequence(parts: Parameters<typeof formatKeySequenceExtra>[0], config: FormatConfig) {
  return formatKeySequenceExtra(parts, formatOptions(config))
}

export function formatKeyBindings(bindings: Parameters<typeof formatCommandBindingsExtra>[0], config: FormatConfig) {
  return formatCommandBindingsExtra(bindings, formatOptions(config))
}

/**
 * The keymap parts every screen needs: the mode stack, comma lists, key aliases and the base layout fallback.
 * The setup screen takes only these; it has no leader chords, and its boxes are inputs, which the managed
 * textarea layer skips.
 */
export function registerAgentCorpBaseKeymap(keymap: OpenTuiKeymap) {
  const modeStack = createAgentCorpModeStack(keymap)
  const offCommaBindings = registerCommaBindings(keymap)
  const offAliasExpander = registerKeyAliases(keymap)
  const offBaseLayout = registerBaseLayoutFallback(keymap)
  return () => {
    offAliasExpander()
    offBaseLayout()
    offCommaBindings()
    modeStack.dispose()
  }
}

export function registerAgentCorpKeymap(keymap: OpenTuiKeymap, renderer: CliRenderer, config: ResolvedKeymapConfig) {
  const offBase = registerAgentCorpBaseKeymap(keymap)
  const leader = leaderKey(config)
  const offLeader = leader
    ? registerTimedLeader(keymap, {
        trigger: leader,
        name: LEADER_TOKEN,
        timeoutMs: config.leader_timeout,
      })
    : () => {}
  const offEscape = registerEscapeClearsPendingSequence(keymap)
  const offBackspace = registerBackspacePopsPendingSequence(keymap)
  const offInputBindings = registerManagedTextareaLayer(keymap, renderer, {
    enabled: () => hasManagedTextareaFocus(renderer),
    bindings: config.keybinds.gather("input", inputCommands),
  })

  return () => {
    offInputBindings()
    offBackspace()
    offEscape()
    offLeader()
    offBase()
  }
}

export function useLeaderActive(): Accessor<boolean> {
  return useKeymapSelector((keymap: OpenTuiKeymap) => keymap.getPendingSequence()[0]?.tokenName === LEADER_TOKEN)
}

export function useCommandShortcut(command: string): Accessor<string> {
  const config = useTuiConfig()
  return useKeymapSelector((keymap: OpenTuiKeymap) =>
    formatKeySequence(
      keymap.getCommandBindings({ visibility: "registered", commands: [command] }).get(command)?.[0]?.sequence,
      config,
    ),
  )
}

export function useCommandSlashes(): Accessor<readonly CommandSlashEntry[]> {
  const keymap = useAgentCorpKeymap()
  const entries = useKeymapSelector((keymap: OpenTuiKeymap) =>
    keymap.getCommandEntries({
      visibility: "reachable",
      namespace: "palette",
      filter: isVisiblePaletteCommand,
    }),
  )

  return createMemo<CommandSlashEntry[]>(() =>
    entries().flatMap((entry) => {
      const slashName = entry.command.slashName
      if (typeof slashName !== "string" || !slashName) return []
      const slashAliases = entry.command.slashAliases
      return {
        display: `/${slashName}`,
        description:
          typeof entry.command.desc === "string"
            ? entry.command.desc
            : typeof entry.command.title === "string"
              ? entry.command.title
              : undefined,
        aliases: Array.isArray(slashAliases)
          ? slashAliases.filter((alias): alias is string => typeof alias === "string").map((alias) => `/${alias}`)
          : undefined,
        onSelect: () => keymap.dispatchCommand(entry.command.name),
      }
    }),
  )
}
