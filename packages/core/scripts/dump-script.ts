// Usage: pnpm dump <file.md> [outFile]
// Writes the spoken script (one segment per line, with source line numbers) for review.
import fs from "node:fs/promises";
import path from "node:path";
import { buildSpeechScript } from "../src/index.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: dump-script <file.md> [out.txt]");
  process.exit(1);
}
const src = await fs.readFile(file, "utf8");
const lineOf = (off: number): number => src.slice(0, off).split("\n").length;

const t0 = performance.now();
const script = await buildSpeechScript(src, { fileName: path.basename(file) });
const ms = performance.now() - t0;

const lines = script.segments.map((s) => {
  const tag = `${String(s.id).padStart(4)} L${lineOf(s.srcRange[0])}`.padEnd(12);
  const pause = s.pauseBefore ? `(+${s.pauseBefore}ms) ` : "";
  return `${tag} ${s.kind.padEnd(10)} ${s.mode === "announce" ? "»" : " "} ${pause}${s.text}`;
});
const words = script.segments.reduce((n, s) => n + s.words.length, 0);
const header = `# ${path.basename(file)}: ${script.segments.length} segments, ${words} words (~${Math.round(words / 160)} min at 160 wpm), built in ${ms.toFixed(0)} ms\n`;
const out = process.argv[3] ?? path.join("out", `${path.basename(file, ".md")}.txt`);
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, header + lines.join("\n") + "\n");
console.log(header.trim(), "→", out);
