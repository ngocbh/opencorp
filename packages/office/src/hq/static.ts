/** The built web app, served publicly: it holds no secrets, and /api answers only through the guard. */
import fs from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import { pipeline } from "node:stream"
import { sendError } from "../daemon/http.ts"
import { header, requestPath } from "./guard.ts"
import { CHECKOUT } from "./version.ts"

/** The cache policy for `assets/`, whose names carry a content hash. */
export const IMMUTABLE = "public, max-age=31536000, immutable"

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
}

/** `text` with `& < > " '` escaped for HTML (Python's `html.escape`). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!)
}

/** The page sent while the app isn't built, naming the `checkout` to build it in. */
export function notBuilt(checkout: string = CHECKOUT): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>OpenCorp HQ</title>
<h1>The web app isn't built</h1><p>Run <code>bun run build</code> in the checkout (${escapeHtml(checkout)}), \
then reload.</p></html>`
}

/** The real path of the regular file `rel` names under `appDir`, or null if there's none or it leaves `appDir`. */
export function resolve(appDir: string, rel: string): string | null {
  if (rel.split("/").includes("..") || rel.includes("\0")) return null
  try {
    const root = fs.realpathSync(appDir)
    // As Python's `app_dir / rel`: an absolute `rel` replaces the folder, and then lands outside it.
    const target = fs.realpathSync(path.resolve(appDir, rel))
    const inside = target === root || target.startsWith(root + path.sep)
    return inside && fs.statSync(target).isFile() ? target : null
  } catch {
    return null // missing, or a name too long for the file system, for one
  }
}

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/vnd.microsoft.icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
}

/** Sends a whole small `body` with `status` and `type`; no body for HEAD. */
function sendText(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type, "content-length": String(Buffer.byteLength(body)) })
  res.end(req.method === "HEAD" ? undefined : body)
}

const notFound = (req: IncomingMessage, res: ServerResponse) =>
  sendText(req, res, 404, "text/plain; charset=utf-8", "not found")

/** Streams the regular file at real path `file` with `cacheControl`; false, having sent nothing, if it can't be
 *  opened as one. The fd is always closed: by the pipeline, which ends when the file is sent, on an error, or when
 *  the client leaves; or here, for HEAD and every failure. */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cacheControl: string): boolean {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd: number
  try {
    // O_NOFOLLOW: a symlink swapped in after resolve is refused. O_NONBLOCK: a FIFO can't hang the open.
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return false
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) {
      fs.closeSync(fd)
      return false
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
    // Explicit, so the guard's writeHead adds HQ's headers before any byte goes out.
    res.writeHead(200, { "content-type": type, "content-length": String(stat.size), "cache-control": cacheControl })
  } catch {
    fs.closeSync(fd)
    res.destroy()
    return true
  }
  if (req.method === "HEAD") {
    fs.closeSync(fd)
    res.end()
  } else pipeline(fs.createReadStream("", { fd }), res, () => {})
  return true
}

/** A file of the built app under `appDir`; `index.html` for a document navigation; a plain 404 for anything else
 *  missing; a page saying how to build in `checkout` while there's no build. Never rejects. */
export async function serveApp(
  req: IncomingMessage,
  res: ServerResponse,
  appDir: string | null,
  checkout: string = CHECKOUT,
): Promise<void> {
  const target = requestPath(req)
  if (req.method !== "GET" && req.method !== "HEAD")
    return sendError(res, 405, "method_not_allowed", `${req.method} is not allowed on ${target}`, {
      allow: "GET, HEAD",
    })
  const index = appDir === null ? null : resolve(appDir, "index.html")
  if (appDir === null || index === null) return sendText(req, res, 503, "text/html; charset=utf-8", notBuilt(checkout))
  const rel = target.slice(1)
  const found = rel ? resolve(appDir, rel) : null
  if (found !== null && sendFile(req, res, found, rel.startsWith("assets/") ? IMMUTABLE : "no-cache")) return
  const dest = header(req, "sec-fetch-dest")
  if (rel.startsWith("assets/") || path.extname(rel) || (dest !== undefined && dest !== "document"))
    // Never index.html: a chunk a rebuild deleted must fail as a missing script, so the app checks its version.
    return notFound(req, res)
  if (!sendFile(req, res, index, "no-cache")) notFound(req, res)
}
