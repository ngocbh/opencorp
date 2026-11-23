import { TextAttributes, type MarkdownInlineHook, type MarkdownRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, untrack } from "solid-js"
import { useOffice } from "../context/office"
import { useRoute } from "../context/route"
import { sessionLabels } from "../util/session"
import { parseSessionMention, sessionMentions } from "../util/session-mention"
import { plainClick } from "./link"

/**
 * Returns a `<markdown>` ref that shows the ids of sessions the TUI holds as links labelled after their sessions
 * (`@minh · codex 1`), and opens one on click: with `view.onOpen` when it gives one, else by going to it. The
 * transcript's own session, the session the route shows and ids the TUI doesn't hold stay plain, since run and
 * question ids look the same. Links re-render when a label changes.
 */
export function useSessionLinks(view: { readonly sessionID: string; readonly onOpen?: (sessionID: string) => void }) {
  const office = useOffice()
  const route = useRoute()
  const renderer = useRenderer()
  // Changes only when a session comes, goes or is named anew, not each time one changes.
  const labels = createMemo(() => sessionLabels(office.state), new Map<string, string>(), {
    equals: (a, b) => a.size === b.size && [...a].every(([id, label]) => b.get(id) === label),
  })
  const labelOf = (sessionID: string) => {
    if (sessionID === view.sessionID) return undefined
    if (route.data.type === "session" && route.data.sessionID === sessionID) return undefined
    return labels().get(sessionID)
  }
  // Labels each ID was last rendered with, so the effect below re-renders only on a change.
  const used = new Map<string, string | undefined>()
  const [version, setVersion] = createSignal(0)
  let markdown: MarkdownRenderable | undefined

  // Markdown runs this on every paragraph and heading, since a ULID has no prefix for its filter to look for;
  // fenced code never gets it.
  const linkSpans: MarkdownInlineHook = (spans, context) => {
    if (context.tableCell) return spans
    const style = context.syntaxStyle.mergeStyles("markup.link.url")
    return spans.flatMap((span) => {
      // A code span links only when it is exactly a session ID, so a command such as `codex resume <id>` stays
      // copyable.
      if (span.link || (span.code && !parseSessionMention(span.text.replace(/^`+\s?|\s?`+$/g, "")))) return [span]
      const mentions = sessionMentions(span.text)
      if (mentions.length === 0) return [span]
      // Odd parts are the mentions.
      const cuts = [0, ...mentions.flatMap((mention) => [mention.start, mention.end]), span.text.length]
      return cuts.slice(1).flatMap((end, index) => {
        const text = span.text.slice(cuts[index], end)
        const mention = index % 2 ? mentions[(index - 1) / 2]! : undefined
        const label = mention && labelOf(mention.id)
        // A new ID wakes the effect below to watch it. Only the effect records a change, so that it re-renders
        // every block naming that session, not just the first to see it.
        if (mention) {
          const seen = used.has(mention.id)
          if (!seen) used.set(mention.id, label)
          if (!seen || used.get(mention.id) !== label) setVersion((value) => value + 1)
        }
        if (!mention || label === undefined) return text ? [{ ...span, text }] : []
        return [
          {
            ...span,
            // Raw markdown mode shows the source.
            text: context.conceal ? label : text,
            fg: style.fg ?? span.fg,
            attributes: style.attributes | TextAttributes.UNDERLINE,
            target: mention.id,
          },
        ]
      })
    })
  }

  createEffect(() => {
    version()
    const changed = [...used].flatMap(([sessionID, label]) => (labelOf(sessionID) === label ? [] : [sessionID]))
    if (!markdown || changed.length === 0) return
    changed.forEach((sessionID) => used.set(sessionID, labelOf(sessionID)))
    // Only blocks that mention a changed session run the hook again; nothing is parsed again.
    untrack(() => markdown!.rerunInlineHook((source) => changed.some((sessionID) => source.includes(sessionID))))
  })

  // Solid calls refs before setting content, so the first parse already runs the hook.
  return (renderable: MarkdownRenderable) => {
    markdown = renderable
    renderable.inlineHook = linkSpans
    renderable.onMouseUp = (event) => {
      if (!plainClick(renderer, event)) return
      const sessionID = renderable.targetAt(event.x, event.y)
      if (!sessionID) return
      event.stopPropagation()
      const open = view.onOpen
      if (open) open(sessionID)
      else route.navigate({ type: "session", sessionID })
    }
  }
}
