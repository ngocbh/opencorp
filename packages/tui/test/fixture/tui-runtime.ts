import { resolve, type Info } from "../../src/config"
import { TuiKeybind } from "../../src/config/keybind"

type ResolvedInput = Omit<Info, "keybinds" | "leader_timeout"> & {
  keybinds?: Partial<TuiKeybind.Keybinds>
  leader_timeout?: number
}

export function createTuiResolvedConfig(input: ResolvedInput = {}) {
  return resolve(input, { terminalSuspend: process.platform !== "win32" })
}
