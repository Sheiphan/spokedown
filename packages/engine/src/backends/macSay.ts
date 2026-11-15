// macOS `say` fallback: zero install, sentence-level highlighting only.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProgressEvent, SynthesisRequest, SynthesisResult, TtsBackend, VoiceInfo } from "../types.js";
import { decodeWav } from "../wav.js";

const run = promisify(execFile);
const BASE_WPM = 185;

export function parseSayVoices(out: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  for (const line of out.split("\n")) {
    // "Samantha            en_US    # Hello! My name is Samantha."  (names may contain spaces/parens)
    const m = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(line);
    if (m && !voices.some((v) => v.id === m[1]!.trim())) voices.push({ id: m[1]!.trim(), name: m[1]!.trim(), language: m[2]!.replace("_", "-") });
  }
  return voices;
}

export class MacSayBackend implements TtsBackend {
  readonly id: string;
  readonly label: string;
  readonly timing = "none" as const;

  constructor(opts: { id: string; label?: string }) {
    this.id = opts.id;
    this.label = opts.label ?? "macOS system voice";
  }

  async init(_onProgress?: (e: ProgressEvent) => void): Promise<void> {
    if (process.platform !== "darwin") throw new Error("The macOS system voice is only available on macOS.");
  }

  async voices(): Promise<VoiceInfo[]> {
    const { stdout } = await run("say", ["-v", "?"]);
    return parseSayVoices(stdout);
  }

  defaultVoice(): string {
    return "Samantha";
  }

  async synthesize(req: SynthesisRequest, signal?: AbortSignal): Promise<SynthesisResult> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spokedown-say-"));
    try {
      const txt = path.join(dir, "in.txt");
      const wav = path.join(dir, "out.wav");
      await fs.writeFile(txt, req.text, "utf8"); // -f avoids any argument parsing of the text
      const args = ["-f", txt, "-o", wav, "--file-format=WAVE", "--data-format=LEI16@24000", "-r", String(Math.round(BASE_WPM * req.speed))];
      if (req.voice) args.unshift("-v", req.voice);
      await run("say", args, { signal });
      const { pcm, sampleRate } = decodeWav(new Uint8Array(await fs.readFile(wav)));
      return { pcm, sampleRate, words: null };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
