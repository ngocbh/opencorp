import type { CommandRun } from "../main"

/** A command that is not built yet: says so on stderr and exits 2. */
export function notImplemented(name: string): CommandRun {
  return async () => {
    console.error(`ac ${name}: not implemented yet`)
    return 2
  }
}
