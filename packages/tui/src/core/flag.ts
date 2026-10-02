// The environment switches the TUI reads.

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["AGENT_CORP_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

export const Flag = {
  AGENT_CORP_DISABLE_MOUSE: truthy("AGENT_CORP_DISABLE_MOUSE"),
  AGENT_CORP_DISABLE_TERMINAL_TITLE: truthy("AGENT_CORP_DISABLE_TERMINAL_TITLE"),
  AGENT_CORP_SHOW_TTFD: truthy("AGENT_CORP_SHOW_TTFD"),
  AGENT_CORP_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("AGENT_CORP_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
}
