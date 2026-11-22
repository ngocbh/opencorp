import { OFFICE, type ConnectionList, type Session } from "@opencorp/protocol"

/**
 * The connection and model a session runs on: a null connection is `office`, and a null model is
 * the connection's own, taken from `list` (unknown without it).
 */
export function sessionModel(session: Pick<Session, "connection" | "model">, list?: ConnectionList) {
  const connection = session.connection ?? OFFICE
  const model = session.model ?? list?.connections.find((c) => c.name === connection)?.model ?? undefined
  return { connection, model }
}

/** The harnesses that run on their own login and model, by `Session.harness`, as the owner reads their names. */
export const HARNESS_NAMES: Readonly<Record<string, string>> = { codex: "Codex", claude: "Claude Code" }

/** `model (connection)`, or the connection alone while its model is unknown; a Codex or Claude Code session names its
 *  harness's own model. */
export function modelLabel(
  session: Pick<Session, "connection" | "model"> & Partial<Pick<Session, "harness" | "harness_model">>,
  list?: ConnectionList,
) {
  const harness = HARNESS_NAMES[session.harness ?? ""]
  if (harness !== undefined) return session.harness_model ? `${session.harness_model} (${harness})` : harness
  const { connection, model } = sessionModel(session, list)
  return model ? `${model} (${connection})` : connection
}
