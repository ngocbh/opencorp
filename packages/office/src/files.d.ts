/** A file embedded with `import path from "./x.sql" with { type: "file" }`: its path (read it with
 *  `platform.ts`'s `embedded()`). */
declare module "*.sql" {
  const path: string
  export default path
}

/** The company template's `.gitignore`, embedded the same way. */
declare module "*.gitignore" {
  const path: string
  export default path
}

/** A Markdown file of fixed text the code shows, such as reach's risks.md, embedded the same way. */
declare module "*.md" {
  const path: string
  export default path
}
