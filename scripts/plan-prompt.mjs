import { readFile, writeFile } from "node:fs/promises";

const source = await readFile(new URL("../prompts/planning.md", import.meta.url), "utf8");
const target = new URL("../plan.html", import.meta.url);
const html = await readFile(target, "utf8");
const escaped = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const block = `<!-- planning-prompt:start --><pre id="planning-prompt">${escaped}</pre><!-- planning-prompt:end -->`;
const updated = html.replace(/<!-- planning-prompt:start -->[\s\S]*?<!-- planning-prompt:end -->/, block);
if (updated === html && !html.includes(block)) throw new Error("Planning prompt markers are missing");
if (process.argv.includes("--check")) {
  if (html !== updated) throw new Error("The plan's prompt snapshot is stale");
} else {
  await writeFile(target, updated);
}
