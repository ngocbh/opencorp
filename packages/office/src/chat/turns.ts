/** Which node of a conversation flow is the turn. */
import { staticPathOf } from "@ngocbh/yian/run"

/** `s` split at its last `/`: the part before it (`""` when there is none) and the part after. */
function splitLast(s: string): [string, string] {
  const lastSlash = s.lastIndexOf("/")
  return lastSlash === -1 ? ["", s] : [s.slice(0, lastSlash), s.slice(lastSlash + 1)]
}

/**
 * A conversation flow's shape: its inbox, its turn node (the take on the inbox), its reply node (which reads
 * the same inbox as its steer inbox), and its exit command.
 */
export class ChatFlow {
  readonly inbox: string
  readonly turn: string
  readonly reply: string
  readonly exit: string

  constructor({ inbox = "messages", turn = "chat/heard", reply = "chat/reply", exit = "/exit" }: {
    inbox?: string
    turn?: string
    reply?: string
    exit?: string
  } = {}) {
    this.inbox = inbox
    this.turn = turn
    this.reply = reply
    this.exit = exit
  }

  /** True for an occurrence of the turn node. */
  isTurn(nodeId: string | null | undefined): boolean {
    return nodeId != null && staticPathOf(nodeId) === this.turn
  }

  /** True for an occurrence of the reply node. */
  isReply(nodeId: string | null | undefined): boolean {
    return nodeId != null && staticPathOf(nodeId) === this.reply
  }

  /** The reply node id that follows this occurrence of the turn, when both share a parent. */
  replyAfter(turnNodeId: string): string | null {
    const [parent] = splitLast(this.turn)
    const [replyParent, reply] = splitLast(this.reply)
    if (parent !== replyParent) return null
    const [prefix] = splitLast(turnNodeId)
    return prefix ? `${prefix}/${reply}` : reply
  }
}

/** The shape of `shared/flows/chat.yaml`; a person's own main flow must keep these node names. */
export const MAIN_CHAT = new ChatFlow()
