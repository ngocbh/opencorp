/** The office-only codec for values inside worker frames: JSON with tags for the values JSON can't hold. */

// Only the form encode writes, so a tag has one spelling.
const BIGINT = /^(0|-?[1-9][0-9]*)$/
// Fixed messages: a frame can hold secrets, so an error never quotes a value.
const PLAIN_V_KEY = "a record with a $v key can't be sent"
const NO_JSON_FORM = "a value with no JSON form can't be sent"
const FORGED_TAG = "a frame holds a $v record that isn't a tag"
const NOT_JSON = "a frame isn't valid JSON"

/** `value` as frame text: JSON, with a `bigint` as `{"$v": "bigint", "s": "<decimal>"}` and `NaN`, `Infinity` and
 *  `-Infinity` as `{"$v": "nan"}`, `{"$v": "inf"}` and `{"$v": "-inf"}`. Everything else is as `JSON.stringify`
 *  writes it: an object's `toJSON()` result, else its own enumerable fields, with `undefined` fields dropped; so a
 *  `Map` or `Set` becomes `{}` and functions are dropped. A boxed number, string or bigint is unwrapped after the
 *  replacer, so `Object(NaN)` writes `null` and a boxed bigint makes `JSON.stringify` throw its own `TypeError`. A
 *  throwing `toJSON()` passes its own error through. Throws a `TypeError` with a fixed message for a record with an
 *  own `$v` key, which would read back as a tag, and for a value with no JSON form (`undefined`, a function). */
export function encode(value: unknown): string {
  const text = JSON.stringify(value, replacer)
  if (text === undefined) throw new TypeError(NO_JSON_FORM)
  return text
}

/** The value `encode` wrote as `text`. Throws a `TypeError` for a record with an own `$v` key that isn't exactly one
 *  of the tags, and a `SyntaxError` with a fixed message and no cause for text that isn't JSON. */
export function decode(text: string): unknown {
  try {
    return JSON.parse(text, reviver)
  } catch (error) {
    // The engine's message quotes the text, which can hold a secret.
    if (error instanceof SyntaxError) throw new SyntaxError(NOT_JSON)
    throw error
  }
}

// JSON.stringify hands the replacer each value after its toJSON() and doesn't hand it the tags the replacer returns,
// so a tag never trips the $v check.
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { $v: "bigint", s: value.toString() }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $v: "nan" }
    if (value === Infinity) return { $v: "inf" }
    if (value === -Infinity) return { $v: "-inf" }
    return value
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, "$v")) {
    throw new TypeError(PLAIN_V_KEY)
  }
  return value
}

// JSON.parse revives bottom-up, so a tag's own fields are plain strings here and a tag deep in a record is revived
// before the record holding it.
function reviver(_key: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, "$v")) return value
  const tag = value as Record<string, unknown>
  const keys = Object.keys(tag).length
  if (tag.$v === "bigint" && keys === 2 && typeof tag.s === "string" && BIGINT.test(tag.s)) return BigInt(tag.s)
  if (keys === 1) {
    if (tag.$v === "nan") return NaN
    if (tag.$v === "inf") return Infinity
    if (tag.$v === "-inf") return -Infinity
  }
  throw new TypeError(FORGED_TAG)
}
