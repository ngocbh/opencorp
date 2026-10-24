/** The `__fs-helper`: one workspace file operation per process, a JSON request in and a JSON reply out. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { tempDir } from "../helpers.ts"
import { helperOp } from "./helpers.ts"

setDefaultTimeout(30_000)

test("requests that are not objects or name no op are error replies", () => {
  const ws = tempDir()
  const cases: [object | string, string][] = [
    ["", "request is not JSON"],
    ["nope", "request is not JSON"],
    ["[]", "request must be a JSON object"],
    ['"x"', "request must be a JSON object"],
    ["null", "request must be a JSON object"],
    [{}, "unknown op"],
    [{ op: 5 }, "unknown op"],
    [{ op: "constructor" }, "unknown op"],
    [{ op: "__proto__" }, "unknown op"],
    [{ op: "toString" }, "unknown op"],
    [{ op: "rm", path: "x" }, "unknown op"],
  ]
  for (const [request, error] of cases) {
    const result = helperOp(ws, request)
    expect(result.stdout).toBe(`{"ok": false, "error": "${error}"}`)
    expect(result.status).toBe(1)
  }
})
