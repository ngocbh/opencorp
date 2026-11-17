/** The rules routes: a chat's rules, each with its source, and removing a session or agent rule as its approver. */
import { Ack, RemoveRuleRequest, RuleList } from "@opencorp/protocol"
import type { z } from "zod"
import type { SessionHarness } from "../../runtime/sessions/harness.ts"
import { actingPerson } from "../auth.ts"
import { HttpError, type Params, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"
import { harness, harnessCall } from "./sessions.ts"

/** The chat's rules: its session's, its agent's (`people/<handle>/rules.yaml`) and the company's (`rules.yaml`), each
 *  with its source, and the rules files that exist but don't load, while which every command asks. */
export function listRules(ctx: RequestContext, params: Params) {
  const found = rulesOf(ctx, "GET /sessions/:id/rules")
  return harnessCall(() => found.rules!(params.id!))
}

/** Removes a session or agent rule of the chat; only its approver may, and a company rule changes only by editing
 *  `rules.yaml` in the company repo. */
export async function removeRule(ctx: RequestContext, params: Params, body: unknown) {
  const rule = body as z.output<typeof RemoveRuleRequest>
  const found = rulesOf(ctx, "POST /sessions/:id/rules/remove")
  const by = actingPerson(ctx)
  await harnessCall(() => found.removeRule!(params.id!, rule, { by }))
  return { ok: true }
}

/** The office's harness, which keeps chats' rules; 501 when it keeps none. */
function rulesOf(ctx: RequestContext, route: string): SessionHarness {
  const found = harness(ctx, route)
  if (found.rules === undefined || found.removeRule === undefined) {
    throw new HttpError(501, "not_implemented", `${route} is not implemented yet`)
  }
  return found
}

/** The rules routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  { method: "GET", path: "/sessions/:id/rules", reply: RuleList, handler: listRules },
  { method: "POST", path: "/sessions/:id/rules/remove", body: RemoveRuleRequest, reply: Ack, handler: removeRule },
]
