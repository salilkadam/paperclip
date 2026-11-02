// Copy the files tsc does not emit: the embedded fonts and the approved
// document sources. Their paths are resolved from import.meta.url at runtime,
// so they must sit beside the compiled modules exactly as they do in src/.
//   node scripts/copy-assets.mjs            -> dist/ (tsc layout)
//   node scripts/copy-assets.mjs --bundle   -> bundle/ (one worker.js in bundle/dist)
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.argv.includes("--bundle");
const fontsTo = bundle ? path.join(root, "bundle/assets") : path.join(root, "dist/assets");
const docsTo = bundle ? path.join(root, "bundle/dist") : path.join(root, "dist/documents");

await mkdir(fontsTo, { recursive: true });
await cp(path.join(root, "src/assets"), fontsTo, { recursive: true });
await mkdir(docsTo, { recursive: true });
const sources = (await readdir(path.join(root, "src/documents"))).filter((name) => name.endsWith(".source.md"));
if (sources.length === 0) throw new Error("no document sources found in src/documents");
for (const name of sources) await cp(path.join(root, "src/documents", name), path.join(docsTo, name));
console.log(`copied fonts and ${sources.length} document source(s) -> ${path.relative(root, fontsTo)}, ${path.relative(root, docsTo)}`);
