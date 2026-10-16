import type { ConnectionList, Session } from "@agent-corp/protocol"

/** The connection set up at onboarding, which sessions from before connections ran on. */
export const OFFICE = "office"

/**
 * The connection and model a session runs on: a null connection is `office`, and a null model is
 * the connection's own, taken from `list` (unknown without it).
 */
export function sessionModel(session: Pick<Session, "connection" | "model">, list?: ConnectionList) {
  const connection = session.connection ?? OFFICE
  const model = session.model ?? list?.connections.find((c) => c.name === connection)?.model ?? undefined
  return { connection, model }
}

/** `model (connection)`, or the connection alone while its model is unknown; a Codex session names Codex's model. */
export function modelLabel(
  session: Pick<Session, "connection" | "model"> & Partial<Pick<Session, "harness" | "harness_model">>,
  list?: ConnectionList,
) {
  if (session.harness === "codex") return session.harness_model ? `${session.harness_model} (Codex)` : "Codex"
  const { connection, model } = sessionModel(session, list)
  return model ? `${model} (${connection})` : connection
}
