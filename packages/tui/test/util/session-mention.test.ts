// The upstream TUI's session-mention tests, for our ids: bare ULIDs with no prefix.
import { expect, test } from "bun:test"
import { parseSessionMention, sessionMentions } from "../../src/util/session-mention"

const id = "01JQ8Z3V4XKM5N6P7R8S9T0WXY"

test("a whole ULID is a mention, wherever it stands in prose", () => {
  expect(parseSessionMention(id)).toEqual({ id })
  expect(sessionMentions(`See ${id}, then (${id}).`).map((match) => match.id)).toEqual([id, id])
  expect(sessionMentions(`See ${id} now`)).toEqual([{ id, text: id, start: 4, end: 30 }])
})

test.each([
  "01JQ8Z3V4X",
  `${id}0`,
  `x${id}`,
  `${id}/path`,
  `https://host/${id}`,
  `@other:${id}`,
  `${id}_x`,
  `${id}-x`,
  id.toLowerCase(),
  // I, L, O and U aren't Crockford base32.
  `${id.slice(0, 25)}U`,
])("does not parse malformed or embedded IDs: %s", (text) => {
  expect(parseSessionMention(text)).toBeUndefined()
  expect(sessionMentions(text)).toEqual([])
})
