// Runs the TUI in this terminal against the stub server: `bun run dev`.
import { Effect } from "effect"
import { run } from "../src/app"
import { Global } from "../src/core/global"
import { createStub } from "./stub"

await Effect.runPromise(run({ ...createStub(), args: {} }).pipe(Effect.provide(Global.layer)))
