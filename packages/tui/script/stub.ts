// A stand-in server for running the TUI without an office: canned answers for the startup
// requests, reusing the test fixtures.
import type { TuiInput } from "../src/app"
import { createTuiResolvedConfig } from "../test/fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../test/fixture/tui-sdk"

// One configured provider keeps the connect-a-provider dialog closed.
const provider = { id: "stub", name: "Stub", source: "custom", env: [], options: {}, models: {} }

/** Returns `run()` input (minus `args`) wired to the stub server. */
export function createStub(): Omit<TuiInput, "args"> {
  const events = createEventSource()
  const { fetch } = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: {} })
    if (url.pathname === "/project/proj_test/directories") return json([])
  }, events)
  return {
    url: "http://stub",
    directory,
    config: createTuiResolvedConfig(),
    fetch,
    events: events.source,
    // No plugins are loaded; setting up the slot registry makes slots render their defaults.
    pluginHost: {
      async start(input) {
        input.runtime.setupSlots(input.api)
      },
      async dispose() {},
    },
  }
}
