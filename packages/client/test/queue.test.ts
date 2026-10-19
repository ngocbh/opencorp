import { expect, test } from "bun:test"
import { runEach } from "../src/queue"

test("runEach runs every function, logging the ones that throw", () => {
  const seen: number[] = []
  const logged: unknown[] = []
  const error = console.error
  console.error = (...args: unknown[]) => void logged.push(args)
  try {
    runEach(
      [
        (n: number) => seen.push(n),
        () => {
          throw new Error("bad reducer")
        },
        (n: number) => seen.push(n + 1),
      ],
      1,
    )
  } finally {
    console.error = error
  }
  expect(seen).toEqual([1, 2])
  expect(logged).toHaveLength(1)
})
