/** Which node of a conversation flow is the turn. */
import { staticPathOf } from "@ngocbh/yian/run"

/**
 * A conversation flow's shape: its inbox, its queue (an inbox only the turn's take reads, for the next turn), its turn
 * node (the take on both), its context node (which folds older turns once the take has run), its summarizer inside
 * that context, its reply node (which reads the inbox as its steer inbox), its exit command, and the tool of a
 * person's model action (`model`), whose `{provider, model}` arguments choose the model of the turns after it.
 */
export class ChatFlow {
  readonly inbox: string
  readonly queue: string
  readonly turn: string
  readonly context: string
  readonly summarizer: string
  readonly reply: string
  readonly exit: string
  readonly model: string

  constructor({
    inbox = "messages",
    queue = "queued",
    turn = "chat/heard",
    context = "chat/context",
    summarizer = "chat/context/compacted/folded/summarize",
    reply = "chat/reply",
    exit = "/exit",
    model = "/model",
  }: {
    inbox?: string
    queue?: string
    turn?: string
    context?: string
    summarizer?: string
    reply?: string
    exit?: string
    model?: string
  } = {}) {
    this.inbox = inbox
    this.queue = queue
    this.turn = turn
    this.context = context
    this.summarizer = summarizer
    this.reply = reply
    this.exit = exit
    this.model = model
  }

  /** True for an occurrence of the turn node. */
  isTurn(nodeId: string | null | undefined): boolean {
    return nodeId != null && staticPathOf(nodeId) === this.turn
  }

  /** True for an occurrence of the reply node. */
  isReply(nodeId: string | null | undefined): boolean {
    return nodeId != null && staticPathOf(nodeId) === this.reply
  }

  /** True for an occurrence of the context node or of any node inside it. */
  inContext(nodeId: string | null | undefined): boolean {
    if (nodeId == null) return false
    const path = staticPathOf(nodeId)
    return path === this.context || path.startsWith(this.context + "/")
  }

  /** The loop iteration a node id sits in (`chat#7/...` is 7), or null for an id outside the turn's loop. */
  iterationOf(nodeId: string): number | null {
    const m = /^([^/#~]+)#(\d+)(?:\/|$)/.exec(nodeId)
    return m !== null && m[1] === this.turn.split("/")[0] ? Number(m[2]) : null
  }

  /** True when one of the nodes is the reply or part of the turn's context: a person's turn is being worked. */
  turnWorks(nodeIds: Iterable<string>): boolean {
    for (const id of nodeIds) if (this.isReply(id) || this.inContext(id)) return true
    return false
  }
}

/** The shape of `shared/flows/chat.yaml`; a person's own main flow must keep these node names. */
export const MAIN_CHAT = new ChatFlow()

/** Whether `message` is a person's model action in `flow`: only actions, one of them naming its `model` tool. */
export function modelAction(message: { readonly parts?: unknown } | null | undefined, flow: ChatFlow = MAIN_CHAT): boolean {
  return actionOnly(message) && (message!.parts as { tool?: unknown }[]).some((part) => part.tool === flow.model)
}

/** Whether `message` holds only `action` parts: something a person did themselves, which a conversation flow notes
 *  for its next answered turn and never answers. */
export function actionOnly(message: { readonly parts?: unknown } | null | undefined): boolean {
  const parts = message?.parts
  return (
    Array.isArray(parts) &&
    parts.length > 0 &&
    parts.every((part) => (part as { type?: unknown } | null)?.type === "action")
  )
}
