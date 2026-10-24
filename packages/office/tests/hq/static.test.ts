/** The built web app, served from app_dir. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { createServer } from "../../src/daemon/http.ts"
import { listenUnix } from "../../src/daemon/sockets.ts"
import { HEADERS, hqGuard } from "../../src/hq/guard.ts"
import { escapeHtml, resolve, serveApp } from "../../src/hq/static.ts"
import { CHECKOUT } from "../../src/hq/version.ts"
import { shortDir, tempDir, waitFor } from "../helpers.ts"
import { parse, raw } from "../daemon/helpers.ts"

setDefaultTimeout(30_000)

const HOST = "127.0.0.1:5555"
const ORIGIN = `http://${HOST}`

/** A built app under `tmp`: index.html, one hashed asset, theme.js and build.json (Python's `dist`). */
function dist(tmp: string): string {
  const root = path.join(tmp, "dist")
  fs.mkdirSync(path.join(root, "assets"), { recursive: true })
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>OpenCorp HQ</title>")
  fs.writeFileSync(path.join(root, "assets", "index-abc123.js"), "console.log(1)")
  fs.writeFileSync(path.join(root, "theme.js"), "// theme")
  fs.writeFileSync(path.join(root, "build.json"), JSON.stringify({ build: "b1", api: "x" }))
  return root
}

/** Serves `appDir` behind the guard (the hq.sock flavour) on a unix socket until the current test finishes. */
async function served(appDir: string | null, checkout: string = CHECKOUT): Promise<string> {
  const server = createServer(hqGuard((req, res) => serveApp(req, res, appDir, checkout), { port: null }))
  const sock = path.join(shortDir(), "s")
  onTestFinished(async () => {
    // On Bun, closeAllConnections also stops the listener, so close's callback may get ERR_SERVER_NOT_RUNNING.
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    fs.rmSync(sock, { force: true })
  })
  await listenUnix(server, sock)
  return sock
}

/** A raw HTTP/1.1 request from the app's own page, asking the server to close the connection after. */
function message(method: string, target: string, headers: string[] = [], body?: string): string {
  const lines = [`${method} ${target} HTTP/1.1`, `Host: ${HOST}`, `Origin: ${ORIGIN}`, ...headers]
  if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
  lines.push("Connection: close")
  return `${lines.join("\r\n")}\r\n\r\n${body ?? ""}`
}

/** Sends one raw request and parses the whole response. */
async function fetchRaw(sock: string, method: string, target: string, headers: string[] = [], body?: string) {
  return parse((await raw(sock, message(method, target, headers, body))).text)
}

/** The values of header `name` in a raw response head. */
function values(head: string, name: string): string[] {
  return head
    .split("\r\n")
    .slice(1)
    .filter((line) => line.toLowerCase().startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1).trim())
}

const value = (head: string, name: string) => values(head, name)[0]

const DOC = ["Sec-Fetch-Dest: document"]

test("an asset is immutable and other files are no cache", async () => {
  const sock = await served(dist(tempDir()))
  const r = await fetchRaw(sock, "GET", "/assets/index-abc123.js")
  expect(r.status).toBe(200)
  expect(r.body).toBe("console.log(1)")
  expect(value(r.head, "cache-control")).toBe("public, max-age=31536000, immutable")
  expect(value(r.head, "content-type")).toBe("text/javascript; charset=utf-8")
  expect(value((await fetchRaw(sock, "GET", "/theme.js")).head, "cache-control")).toBe("no-cache")
})

test("a document navigation gets index html", async () => {
  const sock = await served(dist(tempDir()))
  for (const target of ["/", "/pair", "/people/minh"]) {
    const r = await fetchRaw(sock, "GET", target, DOC)
    expect(r.status).toBe(200)
    expect(r.body).toContain("OpenCorp HQ")
    expect(value(r.head, "cache-control")).toBe("no-cache")
  }
})

test.each([
  ["/assets/gone-123.js", null],
  ["/assets/gone-123.js", "document"],
  ["/gone.css", null],
  ["/company", "image"],
])("a missing asset or non document gets a plain 404 [%s]", async (target, dest) => {
  const sock = await served(dist(tempDir()))
  const r = await fetchRaw(sock, "GET", target, dest ? [`Sec-Fetch-Dest: ${dest}`] : [])
  expect(r.status).toBe(404)
  expect(r.body).not.toContain("OpenCorp HQ")
  expect(value(r.head, "content-type")!.startsWith("text/plain")).toBe(true)
})

test("resolve refuses dot dot and symlinks out of app dir", () => {
  const tmp = tempDir()
  const root = dist(tmp)
  fs.writeFileSync(path.join(tmp, "secret.txt"), "no")
  fs.mkdirSync(path.join(tmp, "outside"))
  fs.writeFileSync(path.join(tmp, "outside", "x.js"), "no")
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(root, "assets", "link.js"))
  fs.symlinkSync(path.join(tmp, "outside"), path.join(root, "assets", "dir"))
  fs.symlinkSync(path.join(root, "assets", "index-abc123.js"), path.join(root, "inside.js"))
  expect(resolve(root, "assets/../../secret.txt")).toBeNull()
  expect(resolve(root, "assets/link.js")).toBeNull()
  expect(resolve(root, "assets/dir/x.js")).toBeNull()
  expect(resolve(root, path.join(tmp, "secret.txt"))).toBeNull()
  expect(resolve(root, "assets/index-abc123.js\0")).toBeNull()
  expect(resolve(root, "assets")).toBeNull()
  expect(resolve(root, `${"a".repeat(5000)}.js`)).toBeNull()
  const asset = fs.realpathSync(path.join(root, "assets", "index-abc123.js"))
  expect(resolve(root, "assets/index-abc123.js")).toBe(asset)
  expect(resolve(root, "inside.js")).toBe(asset)
})

test.each([
  "/assets/%2e%2e/%2e%2e/secret.txt",
  "/%2e%2e/secret.txt",
  "/assets/link.js",
  "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
])("a request never reads outside app dir [%s]", async (target) => {
  const tmp = tempDir()
  const root = dist(tmp)
  fs.writeFileSync(path.join(tmp, "secret.txt"), "the secret")
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(root, "assets", "link.js"))
  const sock = await served(root)
  const r = await fetchRaw(sock, "GET", target)
  expect(r.status).toBe(404)
  expect(r.body).not.toContain("the secret")
})

test("without a build a page says how to build", async () => {
  const sock = await served(path.join(tempDir(), "dist")) // app_dir doesn't exist
  const r = await fetchRaw(sock, "GET", "/", DOC)
  expect(r.status).toBe(503)
  expect(r.body).toContain("bun run build")
  expect(r.body).not.toContain("<script")
  expect(value(r.head, "content-security-policy")!.startsWith("default-src 'none'")).toBe(true)
})

test("a dist without index html is not built", async () => {
  const root = dist(tempDir())
  fs.unlinkSync(path.join(root, "index.html"))
  const sock = await served(root)
  expect((await fetchRaw(sock, "GET", "/", DOC)).status).toBe(503)
})

test("head works and a post to a page is refused", async () => {
  const sock = await served(dist(tempDir()))
  let r = await fetchRaw(sock, "HEAD", "/assets/index-abc123.js")
  expect(r.status).toBe(200)
  expect(r.body).toBe("")
  expect(value(r.head, "x-frame-options")).toBe("DENY")
  expect((await fetchRaw(sock, "HEAD", "/")).status).toBe(200)
  r = await fetchRaw(sock, "POST", "/", ["Content-Type: application/json"], "{}")
  expect(r.status).toBe(405)
  expect(JSON.parse(r.body).error).toBe("method_not_allowed")
  expect(value(r.head, "allow")).toBe("GET, HEAD")
})

test("the not built page escapes the checkout path", async () => {
  expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#x27;")
  const sock = await served(null, "/tmp/<b>x</b>")
  const r = await fetchRaw(sock, "GET", "/", DOC)
  expect(r.status).toBe(503)
  expect(value(r.head, "content-type")).toBe("text/html; charset=utf-8")
  expect(r.body).toContain("in the checkout (/tmp/&lt;b&gt;x&lt;/b&gt;), then reload.")
  expect(r.body).not.toContain("<b>")
})

test("a fifo in app dir is never opened", async () => {
  const root = dist(tempDir())
  execFileSync("mkfifo", [path.join(root, "assets", "pipe.js")])
  expect(resolve(root, "assets/pipe.js")).toBeNull()
  const sock = await served(root)
  // No writer ever opens the FIFO: a server that opened it blocking would hang past this timeout.
  const { text } = await raw(sock, message("GET", "/assets/pipe.js"), { timeout: 5000 })
  expect(parse(text).status).toBe(404)
})

test("a file served behind the guard carries the security headers", async () => {
  const sock = await served(dist(tempDir()))
  const r = await fetchRaw(sock, "GET", "/assets/index-abc123.js")
  expect(r.status).toBe(200)
  for (const [name, expected] of Object.entries(HEADERS)) expect(values(r.head, name)).toEqual([expected])
})

test("a path with a doubled slash is not a file of the app", async () => {
  const sock = await served(dist(tempDir()))
  const r = await fetchRaw(sock, "GET", "//index.html", ["Sec-Fetch-Dest: image"])
  expect(r.status).toBe(404)
  expect(r.body).toBe("not found")
})

test("a client that leaves mid file leaves no file open", async () => {
  const root = dist(tempDir())
  fs.writeFileSync(path.join(root, "assets", "big-123.js"), Buffer.alloc(4 * 1024 * 1024, "x"))
  const sock = await served(root)
  const open = () => fs.readdirSync("/dev/fd").length
  const before = open()
  // `raw` closes its socket once the head has arrived, long before 4 MiB could.
  const { text } = await raw(sock, message("GET", "/assets/big-123.js"), { until: "head" })
  expect(parse(text).status).toBe(200)
  expect(value(parse(text).head, "content-length")).toBe(String(4 * 1024 * 1024))
  await waitFor(() => open() <= before, { timeout: 10_000, what: "the file to close" })
})
