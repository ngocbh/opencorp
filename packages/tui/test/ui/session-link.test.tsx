/** @jsxImportSource @opentui/solid */
// The upstream TUI's session-link tests, for our sessions: a bare ULID links when it names a session the TUI holds,
// and keeps its text, since our sessions have no title.
import { afterEach, expect, test } from "bun:test"
import { CodeRenderable, SyntaxStyle, TextAttributes, type MarkdownRenderable, type Renderable } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, Show, type JSX } from "solid-js"
import { OfficeProvider, useOffice } from "../../src/context/office"
import { RouteProvider, useRoute } from "../../src/context/route"
import { useSessionLinks } from "../../src/ui/session-link"
import { createFakeOffice, type FakeOffice } from "../fixture/fake-office"
import { TestTuiContexts } from "../fixture/tui-environment"

const later = "01JQ8Z3V4XKM5N6P7R8S9T0WXY"
const unknown = "01JQ8Z3V4XKM5N6P7R8S9T0WXZ"

let office: FakeOffice
afterEach(() => office?.stop())

/** A fake office holding the seeded chat, `current`, and `known`, another session. */
function setup() {
  office = createFakeOffice()
  const current = office.state.sessions[0]!.id
  const known = office.newSession({ person: "minh", cwd: "/tmp/proj" }).id
  return { current, known }
}

test("session links in markdown", async () => {
  const { current, known } = setup()
  // The session the transcript shows, a Codex session in the pane, say, beside the chat the route shows.
  const own = office.newSession({ person: "minh", cwd: "/tmp/proj", harness: "codex", kind: "instrument" }).id
  let route!: ReturnType<typeof useRoute>

  function Transcript() {
    route = useRoute()
    const renderer = useRenderer()
    const syntaxStyle = SyntaxStyle.fromStyles(
      { default: { fg: "#ffffff" }, "markup.link.url": { fg: "#00ff00" } },
      renderer.nativeScene,
    )
    onCleanup(() => syntaxStyle.destroy())
    return (
      <markdown
        ref={useSessionLinks({ sessionID: own })}
        syntaxStyle={syntaxStyle}
        content={[
          `**中文** see ${known} now`,
          "",
          `- current ${current}`,
          `- own ${own}`,
          `- unknown ${unknown}`,
          `- later ${later}`,
          "",
          "```",
          known,
          "```",
        ].join("\n")}
      />
    )
  }

  const app = await mount(current, () => <Transcript />, 40, 16)
  const linked = () => underlined(app).join(" ")

  try {
    await waitForHighlightedFrame(
      app,
      (frame) => linked().length > 0 && [current, own, unknown, later, known].every((id) => frame.includes(id)),
    )
    // The chat the route shows, the transcript's own session and ids the TUI doesn't hold stay plain, as does code.
    expect(linked()).toBe(known)
    expect(app.captureCharFrame().split(known)).toHaveLength(3)
    // The office's list is the only lookup.
    expect(office.requests.filter((r) => r.path.includes(unknown) || r.path.includes(later))).toEqual([])

    office.newSession({ id: later, person: "minh", cwd: "/tmp/proj" })
    await waitForHighlightedFrame(app, () => linked() === `${known} ${later}`)

    const rows = app.captureCharFrame().split("\n")
    const clicked = rows.findIndex((row) => row.includes(later))
    app.renderer.clearSelection()
    await app.mockMouse.click(rows[clicked]!.indexOf(later) + 4, clicked)
    expect(route.data).toEqual({ type: "session", sessionID: later })
  } finally {
    app.renderer.destroy()
  }
})

test("a wrapped id opens its session from either row, and plain text, drags and modified clicks do not", async () => {
  const { current, known } = setup()
  let route!: ReturnType<typeof useRoute>

  function Transcript() {
    route = useRoute()
    const renderer = useRenderer()
    const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, renderer.nativeScene)
    onCleanup(() => syntaxStyle.destroy())
    return (
      <markdown
        ref={useSessionLinks({ sessionID: current })}
        syntaxStyle={syntaxStyle}
        content={`**中文** see ${known} now`}
      />
    )
  }

  const app = await mount(current, () => <Transcript />, 20, 6)

  try {
    await waitForHighlightedFrame(app, () => underlined(app).join("") === known)
    const rows = app.captureCharFrame().split("\n")
    const head = rows.findIndex((row) => row.includes(known.slice(0, 4)))
    const tail = rows.findIndex((row) => row.includes(known.slice(-4)))
    expect(tail).toBeGreaterThan(head)
    const x = rows[head]!.indexOf(known.slice(0, 4))

    await app.mockMouse.click(rows[0]!.indexOf("see"), 0)
    await app.mockMouse.click(rows[tail]!.indexOf("now"), tail)
    await app.mockMouse.drag(x, head, x + 3, head)
    app.renderer.clearSelection()
    await app.mockMouse.click(x, head, 0, { modifiers: { ctrl: true } })
    await app.mockMouse.click(x, head, 0, { modifiers: { shift: true } })
    await app.mockMouse.click(x, head, 2)
    expect(route.data).toEqual({ type: "session", sessionID: current })

    app.renderer.clearSelection()
    await app.mockMouse.click(rows[tail]!.indexOf(known.slice(-4)) + 1, tail)
    expect(route.data).toEqual({ type: "session", sessionID: known })
  } finally {
    app.renderer.destroy()
  }
})

test("a click opens the session with onOpen when the transcript gives one", async () => {
  const { current, known } = setup()
  const opened: string[] = []
  let route!: ReturnType<typeof useRoute>

  function Transcript() {
    route = useRoute()
    const renderer = useRenderer()
    const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, renderer.nativeScene)
    onCleanup(() => syntaxStyle.destroy())
    return (
      <markdown
        ref={useSessionLinks({ sessionID: current, onOpen: (id) => opened.push(id) })}
        syntaxStyle={syntaxStyle}
        content={`See ${known}`}
      />
    )
  }

  const app = await mount(current, () => <Transcript />, 80, 4)

  try {
    await waitForHighlightedFrame(app, () => underlined(app).join("") === known)
    const rows = app.captureCharFrame().split("\n")
    const y = rows.findIndex((row) => row.includes(known))
    await app.mockMouse.click(rows[y]!.indexOf(known) + 2, y)
    expect(opened).toEqual([known])
    expect(route.data).toEqual({ type: "session", sessionID: current })
  } finally {
    app.renderer.destroy()
  }
})

test.each([true, false])("code spans link only when they are exactly an ID, conceal %p", async (conceal) => {
  const { current, known } = setup()

  function Transcript() {
    const renderer = useRenderer()
    const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, renderer.nativeScene)
    onCleanup(() => syntaxStyle.destroy())
    return (
      <markdown
        ref={useSessionLinks({ sessionID: current })}
        conceal={conceal}
        syntaxStyle={syntaxStyle}
        content={`Run \`codex resume ${known}\` or open \`${known}\`.`}
      />
    )
  }

  const app = await mount(current, () => <Transcript />, 120, 4)

  try {
    await waitForHighlightedFrame(app, () => underlined(app).length > 0)
    expect(underlined(app)).toEqual([known])
    expect(app.captureCharFrame()).toContain(`codex resume ${known}`)
  } finally {
    app.renderer.destroy()
  }
})

test("a session coming into the list reruns the hook only on the blocks that mention it", async () => {
  const { current, known } = setup()
  let markdown!: MarkdownRenderable

  function Transcript() {
    const links = useSessionLinks({ sessionID: current })
    const renderer = useRenderer()
    const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, renderer.nativeScene)
    onCleanup(() => syntaxStyle.destroy())
    return (
      <markdown
        ref={(renderable: MarkdownRenderable) => {
          links(renderable)
          markdown = renderable
        }}
        syntaxStyle={syntaxStyle}
        content={`First ${known}\n\nSecond ${known} and ${later}\n\nThird ${later}`}
      />
    )
  }

  const app = await mount(current, () => <Transcript />, 80, 8)

  try {
    await waitForHighlightedFrame(app, () => underlined(app).join(" ") === `${known} ${known}`)
    // Record the blocks the hook runs on again.
    const hook = markdown.inlineHook!
    const reran: string[] = []
    markdown.inlineHook = (spans, context) => (reran.push(context.source), hook(spans, context))
    await app.renderOnce()
    reran.length = 0

    office.newSession({ id: later, person: "minh", cwd: "/tmp/proj" })
    await waitForHighlightedFrame(app, () => underlined(app).join(" ") === `${known} ${known} ${later} ${later}`)
    expect(reran.toSorted()).toEqual([`Second ${known} and ${later}`, `Third ${later}`])
  } finally {
    app.renderer.destroy()
  }
})

/** The texts of the underlined spans on screen, in order. */
function underlined(app: TestRendererSetup) {
  return app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .filter((span) => span.attributes & TextAttributes.UNDERLINE)
    .map((span) => span.text.trim())
}

/** Waits for a frame `predicate` accepts, letting code blocks finish highlighting between frames. */
function waitForHighlightedFrame(setup: TestRendererSetup, predicate: (frame: string) => boolean) {
  return setup.waitForFrame(async (frame) => {
    if (predicate(frame)) return true
    await Promise.all(highlighting(setup.renderer.root).map((node) => node.highlightingDone))
    return false
  })
}

function highlighting(node: Renderable): CodeRenderable[] {
  return [
    ...(node instanceof CodeRenderable && node.isHighlighting ? [node] : []),
    ...node.getChildren().flatMap(highlighting),
  ]
}

/** Renders `view` against the fake office, on a session route to `current`, once the office's state is read. */
async function mount(current: string, view: () => JSX.Element, width: number, height: number) {
  function Online(props: { children: JSX.Element }) {
    const office = useOffice()
    return <Show when={office.status() === "online"}>{props.children}</Show>
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <RouteProvider initialRoute={{ type: "session", sessionID: current }}>
          <OfficeProvider socket={office.socket} cwd="/tmp/proj">
            <Online>{view()}</Online>
          </OfficeProvider>
        </RouteProvider>
      </TestTuiContexts>
    ),
    { width, height },
  )
  // Frame waits need the render loop; highlights and the office's events land between frames.
  app.renderer.start()
  return app
}
