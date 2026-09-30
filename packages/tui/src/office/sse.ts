export type SseMessage = { event?: string; id?: string; data: string }

/** An incremental text/event-stream parser: feed bytes as they arrive, in any split. */
export function createParser(onMessage: (m: SseMessage) => void, onComment: (text: string) => void = () => {}) {
  const decoder = new TextDecoder()
  let buf = ""
  let event: string | undefined
  let id: string | undefined
  let data: string[] = []
  const line = (l: string) => {
    if (l === "") {
      if (data.length) onMessage({ ...(event && { event }), ...(id && { id }), data: data.join("\n") })
      event = id = undefined
      data = []
      return
    }
    if (l.startsWith(":")) return onComment(l.slice(1).trimStart())
    const i = l.indexOf(":")
    const field = i < 0 ? l : l.slice(0, i)
    const value = i < 0 ? "" : l.slice(i + 1).replace(/^ /, "")
    if (field === "event") event = value
    else if (field === "id") id = value
    else if (field === "data") data.push(value)
  }
  return {
    feed(chunk: Uint8Array) {
      buf += decoder.decode(chunk, { stream: true })
      let at: number
      while ((at = buf.search(/\r\n|\r|\n/)) >= 0) {
        // A lone \r at the end of the buffer may be the first half of \r\n: wait for more.
        if (buf[at] === "\r" && at + 1 === buf.length) break
        const nl = buf[at] === "\r" && buf[at + 1] === "\n" ? 2 : 1
        line(buf.slice(0, at))
        buf = buf.slice(at + nl)
      }
    },
  }
}
