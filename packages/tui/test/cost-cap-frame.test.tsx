import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../script/stub"
import { bootFrame } from "./fixture/frame"

async function runCommand(app: Awaited<ReturnType<typeof bootFrame>>, title: string) {
  app.input.pressKey("p", { ctrl: true })
  await app.until((f) => f.includes("Commands"))
  // The search box takes focus a moment after it renders.
  await Bun.sleep(50)
  app.input.typeText(title)
  await app.until((f) => f.split(title).length > 2)
  app.input.pressEnter()
}

/** An office whose first session is held at its cost cap, waiting on the owner. */
function capped() {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.updateSession(s.id, { cost: 5, status: "waiting", waiting_on: ["ngocbh"], capped: true })
  return { office, s }
}

const raised = (office: ReturnType<typeof createFakeOffice>, id: string, usd: number) =>
  office.requests.some(
    (r) => r.path === `/sessions/${id}/cost-cap` && (r.body as { cost_cap_usd?: number })?.cost_cap_usd === usd,
  )

test("the cost cap command raises the open session's cap and shows the office's refusal as is", async () => {
  const { office, s } = capped()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("cost cap reached"))
    await runCommand(app, "Raise the cost cap")
    await app.until((f) => f.includes("USD"))
    app.input.typeText("4")
    app.input.pressEnter()
    await app.until((f) => f.includes("the cap must be above"))
    await runCommand(app, "Raise the cost cap")
    await app.until((f) => f.includes("USD"))
    app.input.typeText("20")
    app.input.pressEnter()
    await app.until(() => raised(office, s.id, 20))
    await app.until((f) => f.includes("Cost cap raised to $20"))
  } finally {
    await app.stop()
    office.stop()
  }
})
