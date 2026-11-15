// Check the built site for what the Astro build doesn't fail on: every page in src/content/docs
// built to a page, and every code block that names a language is highlighted (at least two token
// colours), since a language the highlighter doesn't know falls back to plain text with only a
// warning.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const content = fileURLToPath(new URL("../src/content/docs/", import.meta.url));
const problems = [];

const sources = readdirSync(content, { recursive: true, encoding: "utf8" }).filter((path) => /\.mdx?$/.test(path));
for (const source of sources) {
  const slug = source.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
  const page = join(slug, "index.html");
  if (!existsSync(join(dist, page))) problems.push(`${source}: no ${page} in the built site`);
}

const pages = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".html"));
let blocks = 0;
for (const page of pages) {
  const html = readFileSync(join(dist, page), "utf8");
  for (const [, language, code] of html.matchAll(/<pre data-language="([^"]+)"><code>(.*?)<\/code><\/pre>/gs)) {
    if (language === "plaintext") continue;
    blocks++;
    const colours = new Set([...code.matchAll(/--0:(#[0-9A-Fa-f]{3,8})/g)].map((m) => m[1]));
    if (colours.size < 2) problems.push(`${page}: a ${language} block is not highlighted`);
  }
}
if (blocks === 0) problems.push("no highlighted code block found in the built site");
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`check-build: ${pages.length} pages, ${sources.length} sources built, ${blocks} code blocks highlighted`);
