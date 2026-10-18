// The environment switches the TUI reads.

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["OPENCORP_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

export const Flag = {
  OPENCORP_DISABLE_MOUSE: truthy("OPENCORP_DISABLE_MOUSE"),
  OPENCORP_DISABLE_TERMINAL_TITLE: truthy("OPENCORP_DISABLE_TERMINAL_TITLE"),
  OPENCORP_SHOW_TTFD: truthy("OPENCORP_SHOW_TTFD"),
  OPENCORP_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OPENCORP_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
}
