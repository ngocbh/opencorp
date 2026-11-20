/** init's `propose_company` tool: checks the company the interview drafted, then holds it on a card the owner answers
 *  in the chat; their Yes keeps it for init, which creates it once the chat ends. */
import { type Draft, draftProblems, type Teammate } from "../../../company/draft.ts"
import type { QuestionCard, SessionBinding } from "../../../runtime/sessions/builtin.ts"
import type { OfficeTool } from "../../../runtime/worker/rpc.ts"
import { strip } from "../../../util/redact.ts"
import { clean } from "../prompts.ts"

/** The card's title. */
export const TITLE = "OpenCorp wants to create this company"
/** The card's question, after the company. */
export const CONFIRM = "Create this company?"
/** The answer that creates the company. */
export const CREATE = "Yes, create it"
/** The answer that asks for changes. */
export const CHANGE = "No, change something"
/** Why the card asks, in every mode: what `dontAsk`'s refusal names. */
export const CREATING_ASKS = "creating the company needs your yes"
/** What the agent is told after the owner's Yes; the init flow's chat ends on it. */
export const ACCEPTED = "Accepted: OpenCorp creates the company once this chat ends."

const ASK_WHAT = "The owner wants changes; ask what to change"
const AGAIN = "Accepted already: OpenCorp creates the company the owner accepted; reply with one line for the owner."

/** The company the interview agreed on: null until the owner says Yes on its card. */
export class Proposal {
  accepted: Draft | null = null
}

function who(name: string, handle: string, title: string): string {
  return clean(`${name} (@${handle})` + (title ? `, ${title}` : ""))
}

/** `draft` as the owner sees it: the company, the owner, and a line for each teammate, without control characters. */
export function summary(draft: Draft): string[] {
  const { owner } = draft
  const lines = [`Company: ${clean(draft.company)}`, `You: ${who(owner.name, owner.handle, owner.title ?? "CEO")}`]
  if (draft.team.length === 0) return [...lines, "Teammates: none yet"]
  lines.push("Teammates:")
  for (const t of draft.team) {
    const about = strip(clean(t.about))
    lines.push(`  ${who(t.name, t.handle, t.title)}` + (about ? `: ${about}` : ""))
  }
  return lines
}

/** `value` if it is text, else empty. */
const text = (value: unknown): string => (typeof value === "string" ? value : "")

/** `value`'s fields, or none when it isn't an object. */
const fields = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** The draft in propose_company's arguments; a missing field is empty, so the check names it, and an owner with no
 *  title is the CEO. */
export function draftOf(args: Record<string, unknown>): Draft {
  const owner = fields(args.owner)
  const team: Teammate[] = (Array.isArray(args.teammates) ? args.teammates : []).map((value) => {
    const t = fields(value)
    return { name: text(t.name), handle: text(t.handle), title: text(t.title), about: text(t.about) }
  })
  return {
    company: text(args.company),
    owner: { name: text(owner.name), handle: text(owner.handle), title: strip(text(owner.title)) ? text(owner.title) : "CEO" },
    team,
  }
}

/** The card for `draft`: its title, the company, you and each teammate, and the question, which the owner reads whole
 *  before the choices. The title heads the text too, as a single question's card shows only its text. */
export function companyCard(draft: Draft): QuestionCard {
  const question = [TITLE, "", ...summary(draft), "", CONFIRM].join("\n")
  return { title: TITLE, question, options: [CREATE, CHANGE], reason: CREATING_ASKS }
}

/** What `propose_company` needs from its session: where the accepted company goes, and the binding its card is held
 *  through. */
export interface ProposeHost {
  readonly proposal: Proposal
  readonly binding: Pick<SessionBinding, "ask">
}

/** `propose_company` on `args`: a draft with problems returns them, with no card; else the call holds on the company's
 *  card, which asks in every mode (and is refused in `dontAsk`). Yes keeps the draft in `host.proposal`; the other
 *  choice, or what the owner types, tells the agent what to change. Refused once a company has been accepted. */
export function proposeCompany(args: Record<string, unknown>, callId: string | undefined, host: ProposeHost): unknown {
  if (host.proposal.accepted !== null) return AGAIN
  const draft = draftOf(args)
  const problems = draftProblems(draft)
  if (problems.length > 0) {
    return "Problems; ask the owner how to fix each, then propose the company again:\n" + problems.map((p) => `- ${p}`).join("\n")
  }
  if (callId === undefined) return "Not proposed: this call can't wait for the owner's answer."
  return host.binding.ask(companyCard(draft), callId, async (answer) => {
    if (answer.typed) {
      const words = strip(answer.value)
      return words ? `The owner wants changes: ${words}` : ASK_WHAT
    }
    if (answer.value !== CREATE) return ASK_WHAT
    if (host.proposal.accepted !== null) return AGAIN
    host.proposal.accepted = draft
    return ACCEPTED
  })
}

const DESCRIPTION =
  "Propose the company to the owner: its name, the owner, and the first teammates. It checks them first and returns " +
  "the problems to fix with the owner; otherwise it shows the owner the company on a card and returns their answer: " +
  '"Accepted: …" once they say yes, or what they want changed.'

// Every field is optional because Yian fails the whole agent on a call that misses a required one; a gap is a problem
// for the model to fix instead.
const SCHEMA = {
  $defs: {
    Owner: {
      description: "The owner, the company's CEO; a missing field is checked as empty.",
      properties: {
        name: { title: "Name", type: "string" },
        handle: { title: "Handle", type: "string" },
        title: { title: "Title", type: "string", description: 'Their title; "CEO" when empty.' },
      },
      title: "Owner",
      type: "object",
    },
    Teammate: {
      description: "A first teammate, an AI agent reporting to the owner; a missing field is checked as empty.",
      properties: {
        name: { title: "Name", type: "string" },
        handle: { title: "Handle", type: "string" },
        title: { title: "Title", type: "string" },
        about: {
          title: "About",
          type: "string",
          description: "One or two sentences about their work, which start the profile they work from.",
        },
      },
      title: "Teammate",
      type: "object",
    },
  },
  description: DESCRIPTION,
  properties: {
    company: { default: "", title: "Company", type: "string" },
    owner: { anyOf: [{ $ref: "#/$defs/Owner" }, { type: "null" }], default: null },
    teammates: {
      anyOf: [{ items: { $ref: "#/$defs/Teammate" }, type: "array" }, { type: "null" }],
      default: null,
      title: "Teammates",
    },
  },
  title: "propose_company",
  type: "object",
}

/** init's `propose_company` tool for `host`'s session: a group of one, so the model calls it by its own name. */
export function proposeCompanyTool(host: ProposeHost): OfficeTool {
  return { description: DESCRIPTION, parameters: SCHEMA, call: (args, options) => proposeCompany(args, options?.callId, host) }
}
