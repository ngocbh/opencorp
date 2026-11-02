// Sockets that can't be reached in the ways a real office's can, for the CLI's "can't reach the office" messages.
import fs from "node:fs"
import net from "node:net"

/** Leaves a socket file at `file` that no server holds: moved aside while its server closes, then put back. */
export async function staleSocket(file: string) {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(file, resolve))
  fs.renameSync(file, `${file}.x`)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.renameSync(`${file}.x`, file)
}

/** Serves `file` with a server that reads each request, starts an answer and drops the connection; resolves to a
 *  function that closes it and removes the socket. */
export async function droppingSocket(file: string) {
  const server = net.createServer((c) =>
    c.once("data", () => {
      c.write("HTTP/1.1 200 OK\r\nContent-Le")
      c.destroy()
    }),
  )
  await new Promise<void>((resolve) => server.listen(file, resolve))
  return () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        fs.rmSync(file, { force: true })
        resolve()
      }),
    )
}
