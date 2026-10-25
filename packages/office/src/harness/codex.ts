/** One `codex app-server --listen stdio://`: its command, owner-load params, process group and worker record. */
import type { HarnessPolicy } from "@opencorp/protocol"
import { which } from "../install/launch.ts"

export const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const
/** Milliseconds an app-server has to exit after stdin closes, before its group is killed. */
export const CLOSE_GRACE_MS = 5_000
export const START_TIMEOUT_MS = 30_000

/** Codex couldn't be run, didn't start, refused the handshake, or died loading the thread. The message says what
 *  went wrong and what to do; it never holds Codex's stderr, which stays in the session's codex.log. */
export class CodexStartError extends Error {
  override name = "CodexStartError"
}

/** No `codex` on the office's PATH. */
export class CodexMissing extends CodexStartError {
  override name = "CodexMissing"
}

/** Codex runs but has no account signed in. */
export class CodexSignedOut extends CodexStartError {
  override name = "CodexSignedOut"
}

/** `codex app-server --listen stdio://` run by `codex`, or `CodexMissing` when there is none.
 *
 *  The daemon passes `office.tools.codex` and its (pinned) `process.env.OPENCORP_CODEX_BIN` as `override`, which
 *  only words the error. */
export function appServerCommand(codex: string | undefined, override?: string): string[] {
  if (codex === undefined && override)
    throw new CodexMissing(
      `OPENCORP_CODEX_BIN names ${override}, which isn't an executable the office can find; ` +
        "fix or unset it, then run `opencorp doctor`.",
    )
  if (codex === undefined)
    throw new CodexMissing(
      "Codex isn't installed where the office can find it (on its PATH). Install it " +
        "(npm install -g @openai/codex), sign in with `codex login`, then run `opencorp doctor`.",
    )
  return [codex, ...APP_SERVER_ARGS]
}

/** `codex app-server --listen stdio://` with `codex` found on the absolute entries of `env`'s PATH (the office's
 *  own), as the daemon's tools are.
 *
 *  `OPENCORP_CODEX_BIN` in the office's `environ` names another binary (an absolute path, or a name on that PATH). */
export function codexCommand(
  env: Record<string, string | undefined>,
  environ: Record<string, string | undefined> = process.env,
): string[] {
  const override = environ.OPENCORP_CODEX_BIN
  // `||`, as Python's `or`: an empty override means `codex`.
  return appServerCommand(which(override || "codex", env.PATH) ?? undefined, override)
}

/** The params of every owner load (thread/start, thread/resume): the person's sandbox and network, and approvals
 *  that always come to the office's cards whatever the owner's config.toml says.
 *
 *  `config` values are nested objects, never dotted keys: Codex splits override keys on every dot. */
export function ownerLoad(cwd: string, policy: HarnessPolicy | null) {
  return {
    cwd,
    sandbox: policy?.sandbox ?? "read-only",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    config: { sandbox_workspace_write: { network_access: Boolean(policy?.network) } },
  }
}
