export type SessionMention = { id: string }

// Match complete ULIDs only, including while an assistant is streaming one. Run, question and work-item ids look the
// same, so a caller checks that a match names a session.
const pattern = /(?<![\w/:@-])([0-9A-HJKMNP-TV-Z]{26})(?![\w/-])/g

/** The ULIDs in `text` that stand on their own, with where each starts and ends. */
export function sessionMentions(text: string) {
  return Array.from(text.matchAll(pattern), (match) => ({
    id: match[1]!,
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}

/** `text` as a mention when it is exactly one ULID. */
export function parseSessionMention(text: string): SessionMention | undefined {
  const match = sessionMentions(text)[0]

  return match?.text === text ? { id: match.id } : undefined
}
