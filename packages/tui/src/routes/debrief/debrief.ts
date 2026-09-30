import type { Message } from "@agent-corp/protocol"

/**
 * The session's turns: its user messages in order, numbered from 1, each by the first line of
 * its text. Steers are user messages too, so each counts as a turn.
 */
export function turns(messages: readonly Message[]) {
  return messages
    .filter((m) => m.role === "user")
    .map((m, i) => {
      const text = m.parts.flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : []))[0] ?? ""
      return { n: i + 1, text: text.split("\n")[0] }
    })
}

/**
 * The feedback text a turn pick starts with. Feedback is on the whole run, so it names the turn
 * and quotes its start: the quote still says which turn is meant if the office numbers turns
 * differently.
 */
export function aboutTurn(turn: { n: number; text: string }) {
  if (!turn.text) return `About turn ${turn.n}: `
  const chars = [...turn.text]
  const quote = chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : turn.text
  return `About turn ${turn.n} ("${quote}"): `
}
