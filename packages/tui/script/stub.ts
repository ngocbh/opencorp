// A stand-in server for running the TUI without an office: canned answers for the startup
// requests, reusing the test fixtures.
import type { TuiInput } from "../src/app"
import { createTuiResolvedConfig } from "../test/fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../test/fixture/tui-sdk"

/** Returns `run()` input (minus `args`) wired to the stub server. */
export function createStub(): Omit<TuiInput, "args"> {
  const events = createEventSource()
  const { fetch } = createFetch((url) => {
    if (url.pathname === "/project/proj_test/directories") return json([])
  }, events)
  return {
    url: "http://stub",
    directory,
    config: createTuiResolvedConfig(),
    fetch,
    events: events.source,
  }
}
