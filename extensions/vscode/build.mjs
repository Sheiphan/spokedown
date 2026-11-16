// Bundles the extension (and the workspace core/engine packages) into one CJS file.
// Libraries that load data files relative to their own location stay external and
// are resolved from this package's node_modules at runtime.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: ["vscode", "kokoro-js", "@huggingface/transformers", "onnxruntime-node", "mathjax-full", "speech-rule-engine"],
  logLevel: "info",
};

// Script that runs inside the read-along preview webview.
const webview = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/preview.js",
  format: "iife",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

// Assets the preview webview loads at runtime. Copied next to the bundle so the packaged
// extension does not need katex/mermaid in node_modules (mermaid alone is >100 MB).
function vendor() {
  const require = createRequire(import.meta.url);
  const out = "dist/vendor";
  rmSync(out, { recursive: true, force: true });
  const katex = path.dirname(require.resolve("katex/package.json")) + "/dist";
  mkdirSync(`${out}/katex/fonts`, { recursive: true });
  cpSync(`${katex}/katex.min.css`, `${out}/katex/katex.min.css`);
  for (const f of readdirSync(`${katex}/fonts`)) {
    if (f.endsWith(".woff2")) cpSync(`${katex}/fonts/${f}`, `${out}/katex/fonts/${f}`);
  }
  const mermaid = path.dirname(require.resolve("mermaid/package.json")) + "/dist";
  mkdirSync(`${out}/mermaid`, { recursive: true });
  cpSync(`${mermaid}/mermaid.min.js`, `${out}/mermaid/mermaid.min.js`);
}

if (process.argv.includes("--watch")) {
  for (const o of [options, webview]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(options), esbuild.build(webview)]);
}
vendor();
