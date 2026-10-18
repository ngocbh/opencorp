// The TUI's version: a release build defines OPENCORP_VERSION.
declare global {
  const OPENCORP_VERSION: string
}

export const InstallationVersion = typeof OPENCORP_VERSION === "string" ? OPENCORP_VERSION : "local"
export const InstallationChannel = InstallationVersion === "local" ? "local" : "latest"
