// The directories the TUI keeps its own state in.
import os from "node:os"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { opencorpHome } from "@opencorp/client/node"

function root() {
  return path.join(opencorpHome(), "tui")
}

/** Paths for TUI state, resolved from `OPENCORP_HOME` (default `~/.opencorp`) on each read. */
export const Path = {
  get home() {
    return os.homedir()
  },
  get data() {
    return path.join(root(), "data")
  },
  get config() {
    return path.join(root(), "config")
  },
  get state() {
    return path.join(root(), "state")
  },
}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly config: string
  readonly state: string
}

export class Service extends Context.Service<Service, Interface>()("@opencorp/tui/Global") {}

/** Provides `Service` with the current `Path` values. */
export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of({ home: Path.home, data: Path.data, config: Path.config, state: Path.state })),
)

export * as Global from "./global"
