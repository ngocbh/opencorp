import type { Session } from "@agent-corp/protocol"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub, seed } from "../script/stub"
import { bootFrame } from "./fixture/frame"

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/** An office with @minh's session in /tmp/proj 5m ago, @lan's there 2h ago, and @minh's elsewhere 1m ago. */
function office(sessions = ["proj", "lan", "other"]) {
  const state = seed()
  state.people.push({ handle: "lan", name: "Lan", kind: "agent", title: "Designer", manager: "ngocbh" })
  const base = state.sessions[0]
  const all: Record<string, Session> = {
    proj: { ...base, id: "S1", updated_at: ago(5 * 60_000) },
    lan: { ...base, id: "S2", person: "lan", updated_at: ago(2 * 3600_000) },
    other: { ...base, id: "S3", cwd: "/tmp/other", updated_at: ago(60_000) },
  }
  state.sessions = sessions.map((k) => all[k])
  state.messages = Object.fromEntries(state.sessions.map((s) => [s.id, []]))
  state.messages.S1 = [
    {
      id: "M1",
      session_id: "S1",
      role: "user",
      created_at: ago(5 * 60_000),
      parts: [{ id: "a", type: "text", text: "fix the flaky test" }],
    },
  ]
  return createFakeOffice({ seed: state })
}

async function runCommand(app: Awaited<ReturnType<typeof bootFrame>>, title: string) {
  app.input.pressKey("p", { ctrl: true })
  await app.until((f) => f.includes("Commands"))
  // The search box takes focus a moment after it renders.
  await Bun.sleep(50)
  app.input.typeText(title)
  await app.until((f) => f.split(title).length > 2)
  app.input.pressEnter()
}

test("the session list shows this folder's sessions, newest first, and opens one", async () => {
  const fake = office()
  const app = await bootFrame(createStub(fake))
  try {
    await app.until((f) => f.includes("Ask anything"))
    await runCommand(app, "Switch session")
    const f = await app.until(
      (f) => f.includes("@minh · /tmp/proj · 5m ago") && f.includes("@lan · /tmp/proj · 2h ago"),
    )
    expect(f.indexOf("5m ago")).toBeLessThan(f.indexOf("2h ago"))
    expect(f).not.toContain("/tmp/other")
    app.input.pressEnter()
    await app.until((f) => f.includes("fix the flaky test"))
    expect(fake.requests.some((r) => r.path === "/sessions/S1/messages")).toBe(true)
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("turning the directory filter off lists sessions in every folder", async () => {
  const fake = office()
  const app = await bootFrame(createStub(fake))
  try {
    await app.until((f) => f.includes("Ask anything"))
    await runCommand(app, "Disable session directory filtering")
    await app.until((f) => !f.includes("Commands"))
    await runCommand(app, "Switch session")
    const f = await app.until((f) => f.includes("@minh · /tmp/other · 1m ago"))
    expect(f.indexOf("/tmp/other")).toBeLessThan(f.indexOf("/tmp/proj · 5m ago"))
    // The setting is kept in kv.json, which later tests in this run share: turn it back on.
    app.input.pressEscape()
    await app.until((f) => !f.includes("Sessions"))
    await runCommand(app, "Enable session directory filtering")
    await app.until((f) => !f.includes("Commands"))
    await runCommand(app, "Switch session")
    await app.until((f) => f.includes("@minh · /tmp/proj · 5m ago") && !f.includes("/tmp/other"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("--continue opens the newest main session in the folder", async () => {
  const fake = office()
  const app = await bootFrame(createStub(fake), { continue: true })
  try {
    await app.until((f) => f.includes("fix the flaky test"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("--continue stays home when the folder has no session", async () => {
  const fake = office(["other"])
  const app = await bootFrame(createStub(fake), { continue: true })
  try {
    await app.until((f) => f.includes("Ask anything"))
    await Bun.sleep(200)
    expect(await app.until((f) => f.includes("Ask anything"))).not.toContain("@minh · idle")
    expect(fake.requests.some((r) => r.path.endsWith("/messages"))).toBe(false)
  } finally {
    await app.stop()
    fake.stop()
  }
})
