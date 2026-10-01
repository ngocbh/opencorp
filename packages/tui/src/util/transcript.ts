import type { Message, Part, Person, Session } from "@agent-corp/protocol"

export type TranscriptOptions = {
  toolDetails: boolean
}

/** The session's display name: `@handle`, or the raw person id if the person is unknown. */
export function personLabel(people: readonly Person[], id: string) {
  const person = people.find((p) => p.id === id)
  return person ? `@${person.handle}` : id
}

/** A session as markdown: a header, then its messages in creation order. */
export function formatTranscript(
  session: Session,
  messages: readonly Message[],
  people: readonly Person[],
  options: TranscriptOptions,
): string {
  let transcript = `# ${personLabel(people, session.person)} · ${session.cwd}\n\n`
  transcript += `**Session ID:** ${session.id}\n`
  transcript += `**Created:** ${new Date(session.created_at).toLocaleString()}\n`
  transcript += `**Updated:** ${new Date(session.updated_at).toLocaleString()}\n\n`
  transcript += `---\n\n`
  for (const msg of messages.toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    transcript += formatMessage(msg, session, people, options)
    transcript += `---\n\n`
  }
  return transcript
}

/** One message as markdown, headed `## User` or by the session person's handle. */
export function formatMessage(
  msg: Message,
  session: Pick<Session, "person">,
  people: readonly Person[],
  options: TranscriptOptions,
): string {
  let result = msg.role === "user" ? `## User\n\n` : `## ${personLabel(people, session.person)}\n\n`
  for (const part of msg.parts) result += formatPart(part, options)
  return result
}

/** A tool output as text: strings as they are, anything else as JSON. */
export function outputText(output: unknown) {
  if (output === undefined || output === null) return ""
  return typeof output === "string" ? output : JSON.stringify(output, null, 2)
}

/** A fenced block whose fence is longer than any backtick run inside `text`. */
function fenced(text: string, lang = "") {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${text}\n${fence}\n`
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  switch (part.type) {
    case "text":
      return `${part.text}\n\n`
    case "file":
      return `_File:_ ${part.path} (${part.mime})\n\n`
    case "tool": {
      let result = `**Tool: ${part.tool}**\n`
      if (options.toolDetails) {
        if (part.input && Object.keys(part.input).length)
          result += `\n**Input:**\n` + fenced(JSON.stringify(part.input, null, 2), "json")
        const output = outputText(part.output)
        if (output) result += `\n**Output:**\n` + fenced(output)
        if (part.error) result += `\n**Error:**\n` + fenced(part.error)
      }
      return result + `\n`
    }
    case "error":
      return `**Error:** ${part.message}\n\n`
  }
  return ""
}
