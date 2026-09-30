// A stand-in server for running the TUI without an office: canned answers for the startup
// requests, reusing the test fixtures.
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
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

/** Serves `fetch` on a new unix socket under /tmp (macOS caps socket paths at 104 bytes). */
export function serveUnix(fetch: (req: Request) => Response | Promise<Response>, socket?: string) {
  const dir = socket ? undefined : mkdtempSync("/tmp/act-")
  const at = socket ?? path.join(dir!, "o.sock")
  // Bun's types omit idleTimeout for unix sockets, but it still applies: without 0 an event
  // stream that is quiet for 10 s is closed.
  const server = Bun.serve({ unix: at, fetch, ...({ idleTimeout: 0 } as {}) })
  return {
    socket: at,
    stop: () => {
      server.stop(true)
      rmSync(dir ?? at, { recursive: true, force: true })
    },
  }
}
