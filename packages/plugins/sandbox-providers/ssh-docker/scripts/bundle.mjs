// Build a self-contained copy of the plugin (SDK inlined, no node_modules) in
// ./bundle. It can be installed on a running Paperclip instance by local path:
//   POST /api/plugins/install {"packageName": "<dir>", "isLocalPath": true}
// Use it when the server image does not ship this provider pre-built.
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "../../../../package.json"));
const esbuild = await import(require.resolve("esbuild"));
const outDir = path.join(root, "bundle");

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(outDir, "dist"), { recursive: true });

await esbuild.build({
  entryPoints: {
    worker: path.join(root, "src/worker.ts"),
    manifest: path.join(root, "src/manifest.ts"),
  },
  outdir: path.join(outDir, "dist"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: false,
  logLevel: "warning",
  // Some bundled CJS deps call require(); give ESM output a working one.
  banner: { js: "import { createRequire as __pcCreateRequire } from 'node:module'; const require = __pcCreateRequire(import.meta.url);" },
});

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await writeFile(
  path.join(outDir, "package.json"),
  `${JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    type: "module",
    paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
    engines: pkg.engines,
  }, null, 2)}\n`,
);
console.log(`bundled ${pkg.name}@${pkg.version} -> ${path.relative(process.cwd(), outDir)}`);
