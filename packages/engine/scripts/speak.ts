// End-to-end check: Markdown → speech script → audio with word timings.
// Usage: pnpm speak <file.md> [--model kokoro] [--voice af_heart] [--speed 1] [--from 0] [--count 8] [--out out.wav]
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildSpeechScript } from "@spokedown/core";
import { Engine, encodeWav } from "../src/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", default: "kokoro" },
    voice: { type: "string", default: "" },
    speed: { type: "string", default: "1" },
    from: { type: "string", default: "0" },
    count: { type: "string", default: "8" },
    out: { type: "string", default: "out/speak.wav" },
  },
});
const file = positionals[0];
if (!file) throw new Error("usage: speak <file.md> [options]");

const src = await fs.readFile(file, "utf8");
const script = await buildSpeechScript(src, { fileName: path.basename(file) });
const from = Number(values.from);
const segs = script.segments.slice(from, from + Number(values.count));

const home = path.join(os.homedir(), ".cache", "spokedown");
const engine = new Engine({ modelsDir: path.join(home, "models"), cacheDir: path.join(home, "audio") });
const t0 = performance.now();
await engine.prepare(values.model!, (e) => {
  if (e.status === "progress" && e.file?.endsWith(".onnx")) process.stdout.write(`\r  downloading ${e.file} ${Math.round(e.progress ?? 0)}%   `);
});
console.log(`model "${values.model}" ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const pieces: Float32Array[] = [];
let sampleRate = 24000;
let total = 0;
let compute = 0;
const lineOf = (off: number) => src.slice(0, off).split("\n").length;
const timeline: unknown[] = [];
for (const seg of segs) {
  const s = performance.now();
  const audio = await engine.synthesizeSegment(seg, { modelId: values.model!, voice: values.voice, speed: Number(values.speed) });
  const ms = performance.now() - s;
  compute += audio.cached ? 0 : ms / 1000;
  sampleRate = audio.sampleRate;
  const pause = new Float32Array(Math.round(((seg.pauseBefore ?? 0) / 1000) * sampleRate));
  pieces.push(pause, audio.pcm);
  const start = total + pause.length / sampleRate;
  timeline.push({ seg: seg.id, start, words: seg.words.map((w, i) => ({ w: w.text, src: src.slice(w.srcStart, w.srcEnd).slice(0, 40), t: +(start + audio.timings[i]!.start).toFixed(3) })) });
  total = start + audio.duration;
  console.log(
    `#${String(seg.id).padStart(3)} L${String(lineOf(seg.srcRange[0])).padEnd(5)} ${audio.duration.toFixed(2).padStart(6)}s ${audio.cached ? "cache" : `${(audio.duration / (ms / 1000)).toFixed(1)}x`.padStart(5)} ${audio.quality.padEnd(9)} ${seg.text.slice(0, 70)}`,
  );
}
const pcm = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
let o = 0;
for (const p of pieces) {
  pcm.set(p, o);
  o += p.length;
}
await fs.mkdir(path.dirname(values.out!), { recursive: true });
await fs.writeFile(values.out!, encodeWav(pcm, sampleRate));
await fs.writeFile(values.out!.replace(/\.wav$/, ".timings.json"), JSON.stringify(timeline, null, 1));
console.log(`\n${total.toFixed(1)}s of audio, ${compute.toFixed(1)}s compute${compute ? ` (${(total / compute).toFixed(1)}x real time)` : ""} → ${values.out}`);
