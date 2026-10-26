/** The M1 journey on a real office: Minh edits a file, is steered and stopped, and ends his session. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { waitFor } from "../helpers.ts"
import { sandboxAvailable } from "../sandbox/helpers.ts"
import { asked, folder, openOffice } from "./helpers.ts"

const TIMEOUT = 180_000

test.skipIf(!sandboxAvailable())(
  "the m1 journey",
  async () => {
    const office = await openOffice()
    const workspace = folder(path.join(office.root, "project"))
    const fake = office.llm
    // 1. `opencorp` in a fresh folder: the office is healthy, the picker offers Minh, and he edits a file.
    const doctor = await office.opencorp(["doctor"], { cwd: workspace })
    expect(doctor.stdout.split("\n").filter((line) => line.startsWith("fail"))).toEqual([])
    expect(doctor.stdout).toContain("ok    codex        codex-cli 0.0.0-fake")
    const minh = await office.person("minh")
    expect(await office.folderPeople(workspace)).toEqual([])
    fake.script(
      {
        match: "Mark the README done",
        tool_calls: [{ name: "edit_file", arguments: { path: "README.md", old: "TODO", new: "done" } }],
      },
      { match: "Mark the README done", content: "Marked it done." },
    )
    const sid = await office.startChat(minh, workspace, { wait: false }) // the TUI prompts while the session starts
    expect(await office.folderPeople(workspace)).toEqual(["minh"])
    // The worker takes about a second to boot, so the prompt is queued for the first turn.
    expect(await office.status(sid)).toBe("starting")
    await office.prompt(sid, "Mark the README done")
    await office.settled(sid, ["Marked it done."])
    expect(fs.readFileSync(path.join(workspace, "README.md"), "utf8")).toBe("# Demo\n\nStatus: done\n")
    expect(await office.tools(sid)).toEqual([["edit_file", "completed"]])

    // 2. Steer mid-reply: the TUI sends the follow-up with prompt, and it reaches the model's next call.
    fake.script(
      { content: "Looking.", tool_calls: [{ name: "list", arguments: { path: "." } }], hold: true },
      { content: "Added both." },
    )
    await office.prompt(sid, "Add a changelog")
    await fake.waitForRequests(3, 40_000)
    await office.replying(sid)
    expect(await office.status(sid)).toBe("busy")
    await office.prompt(sid, "Also mention the date")
    fake.release()
    await office.settled(sid, ["Marked it done.", "Looking.", "Added both."])
    expect(asked(fake.requests()[3]!)).toContain("Also mention the date")
    expect(await office.users(sid)).toEqual(["Mark the README done", "Add a changelog", "Also mention the date"])

    // Then Esc: the held reply's write never lands, the stopped reply says it was interrupted, and the next prompt
    // gets a fresh reply.
    fake.script(
      {
        content: "Writing.",
        tool_calls: [{ name: "write_file", arguments: { path: "never.txt", content: "x" } }],
        hold: true,
      },
      { content: "Starting over." },
    )
    await office.prompt(sid, "Write never.txt")
    await fake.waitForRequests(5, 40_000)
    await office.replying(sid)
    await office.interrupt(sid)
    fake.release()
    await waitFor(async () => (await office.status(sid)) === "idle", {
      timeout: 40_000,
      what: "the interrupted turn to stop",
    })
    await office.prompt(sid, "Start over")
    // An Esc during a silent model call stops the reply at its first chunk (yian #1146), so the held reply's text
    // lands whole; its write_file call is not run.
    await office.settled(sid, [
      "Marked it done.",
      "Looking.",
      "Added both.",
      "Writing.",
      "[interrupted]",
      "Starting over.",
    ])
    expect(fs.existsSync(path.join(workspace, "never.txt"))).toBe(false)
    expect(fake.requests()).toHaveLength(6) // Esc made no model call of its own
    expect(asked(fake.requests()[5]!)).toContain("Write never.txt") // the stopped turn stays in the history

    // 3. `/end` ends the session.
    const ended = await office.opencorp(["end"], { cwd: workspace })
    expect(ended.stdout.trim()).toBe(`Ending @minh's session ${sid}.`)
    await office.ended(sid)
  },
  TIMEOUT,
)
