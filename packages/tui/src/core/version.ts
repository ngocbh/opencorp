// The TUI's version: a release build defines AGENT_CORP_VERSION.
declare global {
  const AGENT_CORP_VERSION: string
}

export const InstallationVersion = typeof AGENT_CORP_VERSION === "string" ? AGENT_CORP_VERSION : "local"
export const InstallationChannel = InstallationVersion === "local" ? "local" : "latest"
