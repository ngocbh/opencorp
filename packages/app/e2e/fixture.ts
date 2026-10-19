// A fixture HQ for Playwright: the app as built into e2e/dist, served with the office's headers and static rules, and /api
// answered from in-memory state. It tests the app, not the office.
// CSP must equal opencorp.hq.guard.CSP; packages/corp_office/tests/hq/test_app_fixture.py checks it.
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
const HEADERS = {
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
}
const DIST = path.join(import.meta.dir, "dist")
const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 4791)
const build = JSON.parse(readFileSync(path.join(DIST, "build.json"), "utf8"))

/** A file of the built app, index.html for a document navigation, or a plain 404, as the office serves them. */
function serveStatic(req: Request, url: URL): Response {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "")
  const file = path.join(DIST, rel)
  if (rel && !rel.split("/").includes("..") && existsSync(file) && statSync(file).isFile())
    return new Response(Bun.file(file), {
      headers: {
        ...HEADERS,
        "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    })
  const dest = req.headers.get("sec-fetch-dest")
  if (rel.startsWith("assets/") || path.extname(rel) || (dest && dest !== "document"))
    return new Response("not found", { status: 404, headers: HEADERS })
  return new Response(Bun.file(path.join(DIST, "index.html")), { headers: { ...HEADERS, "cache-control": "no-cache" } })
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...HEADERS, ...headers } })

Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0, // event streams stay quiet for longer than Bun's 10 s default
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/api/health") return json({ ok: true, office: { api: build.api }, app: build })
    if (url.pathname.startsWith("/api/")) return json({ error: "no_route", message: "no route" }, 404)
    return serveStatic(req, url)
  },
})
