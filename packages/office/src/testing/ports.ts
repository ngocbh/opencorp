/** A TCP port for a test that no other program takes before the code under test binds it. */
import net from "node:net"
import { hasLoopback6 } from "../util/sockets.ts"

/**
 * A port nothing listens on, on 127.0.0.1 and, with `loopback6` and when this host has one, on ::1, that the system
 * hands to no other program for a minute. A port read from a listener on port 0 and closed is free only a moment: any
 * bind to port 0 or outgoing connection may take it before the code under test binds it. So each host's port is left
 * in TIME_WAIT, by a connection to it that this side closes first (as Yelp's ephemeral-port-reserve does). Linux then
 * gives it to no bind to port 0 and no outgoing connection, while a listener that sets SO_REUSEADDR, as every Node
 * and Bun one does, binds it.
 */
export async function freePort({ loopback6 = false }: { loopback6?: boolean } = {}): Promise<number> {
  const both = loopback6 && hasLoopback6()
  for (let tries = 0; tries < 20; tries++) {
    const port = await heldInTimeWait("127.0.0.1", 0)
    if (port === null) throw new Error("can't bind 127.0.0.1")
    if (!both || (await heldInTimeWait("::1", port)) !== null) return port
  }
  throw new Error("no port free on both 127.0.0.1 and ::1")
}

/** Listens on `host`:`port` (any port when 0), connects to it, and closes this side first, leaving the port in
 *  TIME_WAIT on `host`; resolves to the port, or to null if the bind fails. */
async function heldInTimeWait(host: string, port: number): Promise<number | null> {
  const server = net.createServer()
  const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve))
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false))
    server.listen({ port, host }, () => resolve(true))
  })
  if (!bound) return null
  const at = (server.address() as net.AddressInfo).port
  const client = net.connect({ port: at, host })
  const failed = new Promise<never>((_, reject) => client.once("error", reject))
  const conn = await Promise.race([accepted, failed]).catch((error: unknown) => {
    server.close()
    throw error
  })
  client.on("error", () => {})
  conn.on("error", () => {})
  const closed = [conn, client].map((s) => new Promise<void>((resolve) => s.once("close", () => resolve())))
  // The side whose FIN goes first waits out TIME_WAIT: the accepted socket, at `at`.
  conn.end()
  await Promise.all(closed)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return at
}
