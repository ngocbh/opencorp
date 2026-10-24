/** A file embedded with `import path from "./x.sql" with { type: "file" }`: its path (read it with
 *  `platform.ts`'s `embedded()`). */
declare module "*.sql" {
  const path: string
  export default path
}
