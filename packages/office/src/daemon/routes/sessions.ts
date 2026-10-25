/** Session routes; for now only the helper the question routes share. */
import type { ErrorCode } from "@opencorp/protocol"
import { HarnessError } from "../../chat/state.ts"
import { HttpError } from "../http.ts"

/** Runs a harness call; a `HarnessError` becomes an `HttpError` with its status, code and message. */
export async function harnessCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof HarnessError) throw new HttpError(error.status, error.code as ErrorCode, error.message)
    throw error
  }
}
