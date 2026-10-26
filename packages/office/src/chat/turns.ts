/** Which node of a conversation flow is the turn. */
import { staticPathOf } from "@ngocbh/yian/run"

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
}

/** The shape of `shared/flows/chat.yaml`; a person's own main flow must keep these node names. */
export const MAIN_CHAT = new ChatFlow()
