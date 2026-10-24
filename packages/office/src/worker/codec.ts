/** The office-only codec for values inside worker frames: JSON with tags for the values JSON can't hold, and an
 *  escape for a record that has its own `$v` key, so it never reads back as a tag. */

// Only the form encode writes, so a tag has one spelling.
const BIGINT = /^(0|-?[1-9][0-9]*)$/
// Fixed messages: a frame can hold secrets, so an error never quotes a value.
const NO_JSON_FORM = "a value with no JSON form can't be sent"
const FORGED_TAG = "a frame holds a $v record that isn't a tag"
/** The message of the `SyntaxError` for frame text that isn't JSON. */
export const NOT_JSON = "a frame isn't valid JSON"

/** `value` as frame text: JSON, with a `bigint` as `{"$v": "bigint", "s": "<decimal>"}`, `NaN`, `Infinity` and
 *  `-Infinity` as `{"$v": "nan"}`, `{"$v": "inf"}` and `{"$v": "-inf"}`, and a record with an own `$v` key as
 *  `{"$v": "record", "value": <the record>}`. A record met twice is escaped at each place; a cycle makes
 *  `JSON.stringify` throw its own `TypeError`. Everything else is as `JSON.stringify` writes it: an object's
 *  `toJSON()` result, else its own enumerable fields, with `undefined` fields dropped; so a `Map` or `Set` becomes `{}`
 *  and functions are dropped. A boxed number, string or bigint is unwrapped after the replacer, so `Object(NaN)` writes
 *  `null` and a boxed bigint makes `JSON.stringify` throw its own `TypeError`. A throwing `toJSON()` passes its own
 *  error through. Throws a `TypeError` with a fixed message for a value with no JSON form (`undefined`, a function).
 *
 *  Two values don't round trip (neither comes from yian or from JSON): a boxed primitive with an own `$v` key is
 *  escaped around its unwrapped primitive, which `decode` refuses; and a `toJSON()` result that has its own `toJSON`
 *  and a `$v` key is escaped, then that inner `toJSON` runs on the escaped value. */
export function encode(value: unknown): string {
  // The escapes this call wrote: a wrapper's value is the escaped record itself, never escaped again.
  const wrappers = new WeakSet<object>()
  // JSON.stringify hands the replacer each value after its toJSON(), with the holder as `this`, and doesn't hand it
  // the objects the replacer returns, so a tag or a wrapper never trips the $v check itself.
  const text = JSON.stringify(value, function (this: unknown, key: string, item: unknown): unknown {
    if (typeof item === "bigint") return { $v: "bigint", s: item.toString() }
    if (typeof item === "number") {
      if (Number.isNaN(item)) return { $v: "nan" }
      if (item === Infinity) return { $v: "inf" }
      if (item === -Infinity) return { $v: "-inf" }
      return item
    }
    if (!isRecord(item) || !Object.hasOwn(item, "$v")) return item
    if (key === "value" && wrappers.has(this as object)) return item
    const wrapper = { $v: "record", value: item }
    wrappers.add(wrapper)
    return wrapper
  })
  if (text === undefined) throw new TypeError(NO_JSON_FORM)
  return text
}

/** The value `encode` wrote as `text`. Lenient on purpose: it takes any `{"$v": "record", "value": <record>}`, even
 *  one whose record has no `$v` key (encode writes that for `{ $v: undefined }`). Throws a `TypeError` with a fixed
 *  message for any other record with an own `$v` key that isn't exactly one of the tags, and a `SyntaxError` with a
 *  fixed message and no cause for text that isn't JSON. Never sets a prototype: a `__proto__` key stays a plain key. */
export function decode(text: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // The engine's message quotes the text, which can hold a secret.
    if (error instanceof SyntaxError) throw new SyntaxError(NOT_JSON)
    throw error
  }
  return walk(parsed)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Top-down, because bottom-up revival can't tell an escaped record from a tag inside it. Objects are changed in place:
// JSON.parse makes every key an own data field, so setting `__proto__` here sets that field, not the prototype.
function walk(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = walk(value[i])
    return value
  }
  if (!isRecord(value)) return value
  if (!Object.hasOwn(value, "$v")) return walkFields(value)
  const keys = Object.keys(value).length
  if (value.$v === "record" && keys === 2 && Object.hasOwn(value, "value") && isRecord(value.value)) {
    // The escaped record: only its fields are walked, so its own $v is never read as a tag.
    return walkFields(value.value)
  }
  if (value.$v === "bigint" && keys === 2 && typeof value.s === "string" && BIGINT.test(value.s)) return BigInt(value.s)
  if (keys === 1) {
    if (value.$v === "nan") return NaN
    if (value.$v === "inf") return Infinity
    if (value.$v === "-inf") return -Infinity
  }
  throw new TypeError(FORGED_TAG)
}

function walkFields(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(record)) record[key] = walk(record[key])
  return record
}
