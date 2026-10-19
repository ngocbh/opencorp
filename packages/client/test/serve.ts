// Test servers for the client's transport tests: they record each request and answer it.

export type Seen = { method: string; path: string; query: string; type: string | null; body: string }

const stops: (() => void)[] = []

/** Runs `fn` at the next `stopServers()`. */
export const onStop = (fn: () => void) => void stops.push(fn)

/** Stops every server `serve` started, and runs every `onStop`; call it in `afterEach`. */
export const stopServers = () => stops.splice(0).forEach((f) => f())

/**
 * A server that records each request and answers with `answer` (default `{ok: true}`), on TCP or, with `unix`,
 * on a socket. `base` is its TCP URL with `/api`.
 */
export function serve(opts: { unix?: string; answer?: (req: Request) => Response | Promise<Response> } = {}) {
  const seen: Seen[] = []
  const answer = opts.answer ?? (() => Response.json({ ok: true }))
  const fetch = async (req: Request) => {
    const url = new URL(req.url)
    seen.push({
      method: req.method,
      path: url.pathname,
      query: url.search,
      type: req.headers.get("content-type"),
      body: await req.text(),
    })
    return answer(req)
  }
  const server = opts.unix
    ? Bun.serve({ unix: opts.unix, fetch })
    : Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  onStop(() => server.stop(true))
  return { seen, base: `http://127.0.0.1:${server.port}/api`, stop: () => server.stop(true) }
}
