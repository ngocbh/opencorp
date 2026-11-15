# Writing the OpenCorp docs

This guide is for anyone who writes or reviews a page in `docs/src/content/docs/`. It isn't
published.

## Readers

- Owners install OpenCorp, create a company, and work with their employees in the TUI and HQ.
- Contributor material (how the office is built and tested) lives in the repo, not on the site:
  `AGENTS.md`, `ARCHITECTURE.md` and `CONTRIBUTING.md`. A page links to them on GitHub
  (`https://github.com/ngocbh/opencorp/blob/main/...`) rather than copying them.
- Yian has its own site, [yian.readthedocs.io](https://yian.readthedocs.io/). Link to it for
  how flows work; don't repeat it.

## Voice

- Use plain words and short sentences. Write to "you".
- Be concise and direct. Say each thing once, in as few words as it needs; cut what a reader
  doesn't need to use OpenCorp.
- Open each page with a sentence or two on what it is for.
- Give one example per concept. Put anything readers look up (flags, keys, defaults) in a list
  or a table.
- Describe OpenCorp as it is. No history: no "used to", "now", "new", "changed" or "no longer".
- No internal names, issue numbers or plan labels.
- Use sentence case for titles and headings.

## The code is the source of truth

Check each statement against the code and its tests: the office in `packages/office/`, the
`opencorp` command in `packages/cli/`, the installer in `install.sh`. When a page and the code
disagree, follow the code and say so in your PR description. When behavior changes, update the
page in the same PR.

## Pages and links

- One `.md` page per sidebar entry, with `title` and `description` in its front matter.
- Add a new page to the sidebar in `docs/astro.config.mjs`.
- Link by absolute path with a trailing slash: `[HQ](/hq/)`, `[HQ settings](/hq-settings/)`.
  The build fails on a link or anchor that doesn't exist.
- `README.md` keeps the pitch, the one-line install and a link to the site. The user guide is
  here, not in the README.
- `docs/plans/` is local and gitignored. Never link to it or publish it.

## Examples

- Show commands in `console` blocks, each line starting with `$ `, followed only by what the
  command prints on stdout.
- Tag other code with its language, such as `sh` for a script or `json` for a file.

## Before you open a PR

Run `(cd docs && bun install --frozen-lockfile && bun run build)`; the build needs Node 22.23.4
or later. It checks the links, that every page built, and that every tagged code block is
highlighted.
