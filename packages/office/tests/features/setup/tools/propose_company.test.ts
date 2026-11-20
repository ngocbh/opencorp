/** init's propose_company tool: its check comes first, then a card the owner answers in the chat; Yes keeps the
 *  company for init, and anything else tells the agent what to change. */
import { expect, test } from "bun:test"
import type { Draft } from "../../../../src/company/draft.ts"
import { dontAskRefusal } from "../../../../src/runtime/permissions/policy.ts"
import type { CardAnswer, QuestionCard } from "../../../../src/runtime/sessions/builtin.ts"
import {
  ACCEPTED,
  CHANGE,
  CONFIRM,
  CREATE,
  CREATING_ASKS,
  Proposal,
  proposeCompany,
  proposeCompanyTool,
  summary,
  TITLE,
} from "../../../../src/features/setup/tools/propose_company.ts"

const OWNER = { name: "Hong Ngoc Bui", handle: "ngocbh", title: "CEO" }
const MINH = { name: "Minh", handle: "minh", title: "Engineer", about: "Writes the backend." }
const ACME = { company: "Acme", owner: OWNER, teammates: [MINH] }
/** `ACME` as init makes it. */
const DRAFT: Draft = { company: "Acme", owner: OWNER, team: [MINH] }

/** propose_company in a session whose owner answers its cards with `answers`, in order; "dontAsk" is a host in
 *  dontAsk mode, which refuses the card. */
function proposing(answers: (CardAnswer | "dontAsk")[] = []) {
  const proposal = new Proposal()
  const cards: QuestionCard[] = []
  const host = {
    proposal,
    binding: {
      ask: (card: QuestionCard, _callId: string, act: (answer: CardAnswer, signal: AbortSignal) => Promise<unknown>) => {
        cards.push(card)
        const answer = answers.shift()
        if (answer === undefined) throw new Error("no answer left for the card")
        return answer === "dontAsk" ? dontAskRefusal(card.reason) : act(answer, new AbortController().signal)
      },
    },
  }
  /** propose_company on `args`, as the model calls it. */
  const propose = (args: Record<string, unknown>) =>
    Promise.resolve(proposeCompany(args, "r/init/1/0", host)) as Promise<string>
  return { proposal, cards, propose, host }
}

const YES: CardAnswer = { value: CREATE, typed: false }

test("a draft with problems returns them and holds no card", async () => {
  const { propose, cards, proposal } = proposing()
  const told = await propose({ company: "", owner: OWNER, teammates: [{ ...MINH, handle: "Minh" }, { name: "Lan" }] })
  expect(told).toStartWith("Problems; ask the owner how to fix each, then propose the company again:\n")
  expect(told).toContain("- the company needs a name")
  expect(told).toContain("- @Minh can't be a handle:")
  // A missing field is checked as empty, so the model learns what's missing rather than failing the call.
  expect(told).toContain("can't be a handle")
  expect(told).toContain("needs a title")
  const empty = await propose({})
  expect(empty).toContain("- the company needs a name")
  expect(empty).toContain("- the owner needs a name")
  expect(cards).toEqual([])
  expect(proposal.accepted).toBeNull()
})

test("a good draft holds a card showing the company, you and each teammate, with Yes, No and a typed answer", async () => {
  const { propose, cards } = proposing([{ value: CHANGE, typed: false }])
  await propose({ ...ACME, teammates: [MINH, { name: "Lan", handle: "lan", title: "QA", about: "" }] })
  expect(cards).toEqual([
    {
      title: TITLE,
      question: [
        TITLE,
        "",
        "Company: Acme",
        "You: Hong Ngoc Bui (@ngocbh), CEO",
        "Teammates:",
        "  Minh (@minh), Engineer: Writes the backend.",
        "  Lan (@lan), QA",
        "",
        CONFIRM,
      ].join("\n"),
      options: [CREATE, CHANGE],
      reason: CREATING_ASKS,
    },
  ])
  expect(TITLE).toBe("OpenCorp wants to create this company")
  expect([CONFIRM, CREATE, CHANGE]).toEqual(["Create this company?", "Yes, create it", "No, change something"])
  expect(CREATING_ASKS).toBe("creating the company needs your yes")
  // The model's schema types every field the draft reads, a teammate's `about` among them, and requires none, so a
  // gap is a problem for the model to fix rather than a failed call.
  const tool = proposeCompanyTool(proposing().host)
  const schema = tool.parameters as Record<string, any>
  expect(Object.keys(schema.properties)).toEqual(["company", "owner", "teammates"])
  expect(Object.keys(schema.$defs.Owner.properties)).toEqual(["name", "handle", "title"])
  expect(Object.keys(schema.$defs.Teammate.properties)).toEqual(["name", "handle", "title", "about"])
  expect(schema.required).toBeUndefined()
})

test("Yes keeps the draft for init and says it is accepted", async () => {
  const { propose, proposal, cards } = proposing([YES])
  expect(await propose(ACME)).toBe(ACCEPTED)
  expect(ACCEPTED).toBe("Accepted: OpenCorp creates the company once this chat ends.")
  expect(proposal.accepted).toEqual(DRAFT)
  // An owner with no title is the CEO.
  const untitled = proposing([YES])
  await untitled.propose({ ...ACME, owner: { name: OWNER.name, handle: OWNER.handle } })
  expect(untitled.proposal.accepted!.owner.title).toBe("CEO")
  // Once accepted, the company can't be replaced: a second call holds no card.
  expect(await propose({ ...ACME, company: "Other" })).toStartWith("Accepted already:")
  expect(cards).toHaveLength(1)
  expect(proposal.accepted).toEqual(DRAFT)
})

test("No, or typed words, reach the agent as what to change, and keep nothing", async () => {
  const { propose, proposal } = proposing([
    { value: CHANGE, typed: false },
    { value: "  call it Acme Labs  ", typed: true },
    { value: "   ", typed: true },
  ])
  expect(await propose(ACME)).toBe("The owner wants changes; ask what to change")
  expect(await propose(ACME)).toBe("The owner wants changes: call it Acme Labs")
  expect(await propose(ACME)).toBe("The owner wants changes; ask what to change")
  expect(proposal.accepted).toBeNull()
})

test("the card asks in every mode and is refused in dontAsk", async () => {
  // The tool never decides it: every call holds on the card, whatever the mode; a host in dontAsk refuses it.
  const { propose, proposal, cards } = proposing(["dontAsk"])
  expect(await propose(ACME)).toBe(`Not run: this session doesn't ask (dontAsk mode): ${CREATING_ASKS}.`)
  expect(cards).toHaveLength(1)
  expect(proposal.accepted).toBeNull()
  // A call that can't be held asks nothing and keeps nothing.
  const unheld = proposing()
  expect(proposeCompany(ACME, undefined, unheld.host)).toBe("Not proposed: this call can't wait for the owner's answer.")
  expect(unheld.cards).toEqual([])
})

test("the summary lists the company you and each teammate", () => {
  expect(summary({ company: "Acme", owner: OWNER, team: [MINH, { name: "Lan", handle: "lan", title: "QA", about: "" }] })).toEqual([
    "Company: Acme",
    "You: Hong Ngoc Bui (@ngocbh), CEO",
    "Teammates:",
    "  Minh (@minh), Engineer: Writes the backend.",
    "  Lan (@lan), QA",
  ])
  expect(summary({ company: "Acme", owner: OWNER, team: [] }).at(-1)).toBe("Teammates: none yet")
})

test("the summary strips control characters from model text", () => {
  const answers: Draft = {
    company: "Ac\x1b[2Jme",
    owner: { handle: "ngocbh", name: "Hong\nNgoc\x07 Bui" },
    team: [{ name: "Mi\rnh", handle: "minh", title: "Eng\tineer", about: "Writes\x7f the backend." }],
  }
  expect(summary(answers)).toEqual([
    "Company: Ac[2Jme",
    "You: Hong Ngoc Bui (@ngocbh), CEO",
    "Teammates:",
    "  Mi nh (@minh), Eng ineer: Writes the backend.",
  ])
})
