/**
 * A run's AGENT model calls for Run Logs, read with yian's reader: `agentCalls` lists them and `agentCall` rebuilds one
 * (its request, attempts, reply and tool results). Yian's view becomes the protocol's shape here: ints as JSON numbers,
 * the provider data beside a message left out, a media part named by its type, and each string longer than
 * CALL_TEXT_CHARS cut with "…" and named in `cut`. Nothing is scrubbed: the view holds what the run log records, and
 * yian leaves the key, headers and connection out of the model config.
 */
import {
  agentCall,
  type AgentCallEntry,
  type AgentCallUsage,
  type AgentCallView,
  agentCalls,
  type Message,
  type MessagePart,
} from "@ngocbh/yian/run"
import type { RunCall, RunCallEntry, RunCallMessage, RunCallPart, RunCallUsage } from "@opencorp/protocol"
import { DEPTH_CAP, type FoldOptions } from "./reader.ts"

/** The most UTF-16 code units of one string a call shows; a longer one is cut with "…" and named in `cut`. */
export const CALL_TEXT_CHARS = 64 << 10

/** The model calls node `node` made in the log at `log`, oldest first. */
export function nodeCalls(log: string, node: string): RunCallEntry[] {
  return agentCalls(log)
    .filter((call) => call.nodeId === node)
    .map(entryWire)
}

/** Whether node `node` made a model call one of whose attempts is step `n`: a call's attempts are its last `attempts`
 *  steps up to its `n`, with nothing between them. */
export function hasCall(log: string, node: string, n: number): boolean {
  return agentCalls(log).some((call) => call.nodeId === node && n <= call.n && n > call.n - call.attempts)
}

/** Model call `n` (any of its attempts) of node `node` in the log at `log`, rebuilt under `fold` (the run's
 *  environment and code root; null for the one it recorded). */
export async function readCall(
  log: string,
  node: string,
  n: number,
  fold: { env: FoldOptions["env"]; codeRoot: string | null },
): Promise<RunCall> {
  return callWire(await agentCall(log, { nodeId: node, n }, { env: fold.env, codeRoot: fold.codeRoot }))
}

/** A listed call in the protocol's words. */
export function entryWire(call: AgentCallEntry): RunCallEntry {
  return {
    node_id: call.nodeId,
    n: call.n,
    purpose: call.purpose,
    model: call.model,
    started_at: call.startedAt,
    attempts: call.attempts,
    finish: call.finish,
  }
}

/** Yian's view of a call as the protocol's `RunCall`, its long strings cut. */
export function callWire(view: AgentCallView): RunCall {
  const { request } = view
  const call = {
    node_id: view.nodeId,
    n: view.n,
    purpose: view.purpose,
    request:
      request === null
        ? null
        : {
            model: request.model,
            params: request.params,
            system: request.system,
            messages: request.messages.map(messageWire),
            tools: request.tools.map(({ name, description, parameters, strict }) => ({
              name,
              description,
              parameters,
              strict,
            })),
            tool_choice: request.toolChoice,
            parallel_tool_calls: request.parallelToolCalls,
            output_format: request.outputFormat,
          },
    digest_mismatch: view.digestMismatch,
    attempts: view.attempts.map((attempt) => ({
      n: attempt.n,
      started_at: attempt.startedAt,
      first_token_at: attempt.firstTokenAt,
      finished_at: attempt.finishedAt,
      error: attempt.error,
      retry_in: attempt.retryIn,
      usage: usageWire(attempt.usage),
    })),
    reply: view.reply === null ? null : messageWire(view.reply),
    tool_results: view.toolResults.map((result) => ({
      call_id: result.callId,
      name: result.name,
      arguments: result.arguments,
      output: result.output,
      is_error: result.isError,
      closed: result.closed,
      started_at: result.startedAt,
      note: result.note,
      held: result.held,
      release_note: result.releaseNote,
    })),
    usage: usageWire(view.usage),
    finish: view.finish,
    interrupted: view.interrupted,
  }
  const cut: string[] = []
  return { ...(plain(call, "", cut, 0) as Omit<RunCall, "cut">), cut }
}

/** Token counts in the protocol's words. */
function usageWire(usage: AgentCallUsage | null): RunCallUsage | null {
  if (usage === null) return null
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_creation_tokens: usage.cacheCreationTokens,
    reasoning_tokens: usage.reasoningTokens,
  }
}

/** A message without the provider data beside it or its parts. */
function messageWire(message: Message): RunCallMessage {
  return { role: message.role, author: message.author ?? null, parts: message.parts.map(partWire) }
}

function partWire(part: MessagePart): RunCallPart {
  switch (part.type) {
    case "text":
    case "reasoning":
    case "refusal":
      return { type: part.type, text: part.text }
    case "tool_call":
      return {
        type: "tool_call",
        id: part.id,
        name: part.name,
        arguments: part.arguments ?? null,
        raw_arguments: part.raw_arguments ?? null,
      }
    case "tool_result":
      return { type: "tool_result", call_id: part.call_id, name: part.name, content: part.content, is_error: part.is_error ?? null }
    case "media":
      return { type: "media", mime: part.mime, name: part.name ?? null }
    case "action": {
      // A person's action on one of the agent's tools: the protocol has no part for it, so it shows as the line the
      // model read. The office sends no actions yet.
      const { tool, summary, arguments: args, result } = part
      const fields = { tool, summary: summary ?? undefined, arguments: args ?? undefined, result: result ?? undefined }
      const line = JSON.stringify(fields, (_key, value: unknown) => typeof value === "bigint" ? jsonInt(value) : value)
      return { type: "text", text: `action: ${line}` }
    }
  }
}

/** yian's int as JSON: a number, or its digits past the safe integers. */
function jsonInt(value: bigint): number | string {
  return Number.isSafeInteger(Number(value)) ? Number(value) : String(value)
}

/** `text` as one JSON pointer token. */
const token = (text: string) => text.replaceAll("~", "~0").replaceAll("/", "~1")

/**
 * `value`, at JSON pointer `at`, as plain JSON: a bigint (yian's int) as a number, or as its digits past the safe
 * integers; a string longer than CALL_TEXT_CHARS cut with "…"; a container DEPTH_CAP deep as "…". Each cut is named in
 * `cut`.
 */
function plain(value: unknown, at: string, cut: string[], depth: number): unknown {
  if (typeof value === "bigint") return jsonInt(value)
  if (typeof value === "string") {
    if (value.length <= CALL_TEXT_CHARS) return value
    cut.push(at)
    // Never half of a surrogate pair.
    const end = /[\uD800-\uDBFF]/.test(value[CALL_TEXT_CHARS - 1]!) ? CALL_TEXT_CHARS - 1 : CALL_TEXT_CHARS
    return `${value.slice(0, end)}…`
  }
  if (value === null || typeof value !== "object") return value
  if (depth >= DEPTH_CAP) {
    cut.push(at)
    return "…"
  }
  if (Array.isArray(value)) return value.map((item, i) => plain(item, `${at}/${i}`, cut, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = plain(item, `${at}/${token(key)}`, cut, depth + 1)
  }
  return out
}
