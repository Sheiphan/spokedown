// Bundles the extension (and the workspace core/engine packages) into one CJS file.
// Libraries that load data files relative to their own location stay external and
// are resolved from this package's node_modules at runtime.
import * as esbuild from "esbuild";

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

if (process.argv.includes("--watch")) {
  for (const o of [options, webview]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(options), esbuild.build(webview)]);
}
