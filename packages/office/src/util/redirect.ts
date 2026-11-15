/** A page that sends a browser on to a link, so the link never sits in an opener's arguments; and HTML escaping. */

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
}

/** `text` with `& < > " '` escaped for HTML (Python's `html.escape`). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!)
}

/** A page that sends the browser on to `link` at once, its link escaped: what a redirect file holds, so the code never
 *  sits in an opener's arguments. */
export function redirectPage(link: string): string {
  const href = escapeHtml(link)
  return (
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}">` +
    `<title>OpenCorp HQ</title><a href="${href}">Open OpenCorp HQ</a>\n`
  )
}
