// Diagnostics: phoneme-word vs text-word alignment for one segment, and where time goes.
// Usage: tsx scripts/diag.ts <file.md> <segmentId> [fp32|q8]
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSpeechScript } from "@mdreader/core";
import { KokoroOnnxBackend } from "../src/index.js";

const [file, segId, dtype = "fp32"] = process.argv.slice(2);
const src = await fs.readFile(file!, "utf8");
const seg = (await buildSpeechScript(src)).segments[Number(segId)]!;
console.log(`segment ${segId}: ${seg.text}\n`);

const b = new KokoroOnnxBackend({ id: "k", modelId: "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped", dtype: dtype as "fp32", modelsDir: path.join(os.homedir(), ".cache/mdreader/models") });
await b.init();
const tts = (b as unknown as { tts: { model: (i: unknown) => Promise<unknown>; stream: (s: unknown, o: unknown) => AsyncIterable<{ phonemes: string; text: string }> } }).tts;
let modelMs = 0;
const inner = tts.model;
tts.model = async (i: unknown) => {
  const s = performance.now();
  const r = await inner(i);
  modelMs += performance.now() - s;
  return r;
};

const s = performance.now();
const r = await b.synthesize({ text: seg.text, voice: "af_heart", speed: 1 });
const total = performance.now() - s;
const dur = r.pcm.length / r.sampleRate;
console.log(`audio ${dur.toFixed(2)}s | total ${(total / 1000).toFixed(2)}s (${(dur / (total / 1000)).toFixed(1)}x) | model ${(modelMs / 1000).toFixed(2)}s (${(dur / (modelMs / 1000)).toFixed(1)}x) | other ${((total - modelMs) / 1000).toFixed(2)}s`);
console.log(`words: segment=${seg.words.length} engine=${r.words?.length ?? "null"}\n`);

const mod = await import("kokoro-js");
const sp = new mod.TextSplitterStream();
sp.push(seg.text);
sp.close();
let ti = 0;
for await (const c of tts.stream(sp, { voice: "af_heart" })) {
  const ph = c.phonemes.split(" ");
  const tw = c.text.split(" ");
  console.log(`chunk: ${tw.length} text words / ${ph.length} phoneme words`);
  for (let i = 0; i < Math.max(ph.length, tw.length); i++) {
    const flag = (tw[i] === undefined || ph[i] === undefined) ? "  <<<" : "";
    console.log(`  ${String(ti + i).padStart(3)} ${(tw[i] ?? "").padEnd(16)} ${ph[i] ?? ""}${flag}`);
  }
  ti += tw.length;
}
