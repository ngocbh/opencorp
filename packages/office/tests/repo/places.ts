/**
 * Where each office file goes while the old folders move to the layers (ARCHITECTURE.md, "The office's layers").
 *
 * `PLACES` and `TEST_PLACES` map each file at an old path under `src/` or `tests/` to its final path. The relayout
 * codemod (`script/relayout.ts`) moves one category's files and deletes their lines. `UPWARD` and `CYCLES` are the
 * imports that still point up and the folder cycles inside a category: a PR that fixes one deletes its line, and no
 * PR adds one. `layer_direction.test.ts` and `layout.test.ts` hold every list exact. This file goes once the moves
 * are done.
 */

/** Each `src/` file at an old path, by its path under `src/`: its final path. */
export const PLACES: Readonly<Record<string, string>> = {
}

/** Each `tests/` file at an old path, by its path under `tests/`: its final path. */
export const TEST_PLACES: Readonly<Record<string, string>> = {
}

/** Each import that still points up, one line per name, as `<importer> -> <imported> <name>` in today's `src/`
 *  paths. A dynamic import's name is `import()`. */
export const UPWARD: readonly string[] = []

/** Each folder cycle inside a category, as its folders sorted; a category's root files are the category. */
export const CYCLES: readonly (readonly string[])[] = []
