// Kokoro-82M via ONNX Runtime (Node). The "-timestamped" export has a second output,
// `durations` (frames per input token), which gives exact word timings.
import type { WordTiming } from "@spokedown/core";
import type { KokoroDtype, ProgressEvent, SynthesisRequest, SynthesisResult, TtsBackend, VoiceInfo } from "../types.js";

const SAMPLE_RATE = 24000;

/**
 * Durations → word timings. Kokoro tokenizes one id per phoneme character with a
 * pad token at each end, so durations.length === phonemes.length + 2. Words are
 * the space-separated runs of the phoneme string; punctuation-only runs merge
 * into the previous word. Returns null if the shapes don't line up.
 */
export function durationsToWordTimings(phonemes: string, durations: ArrayLike<number>, audioSeconds: number): WordTiming[] | null {
  const chars = [...phonemes];
  if (durations.length !== chars.length + 2) return null;
  let total = 0;
  for (let i = 0; i < durations.length; i++) total += durations[i]!;
  if (!(total > 0)) return null;
  const secPer = audioSeconds / total;

  const words: { ph: string; start: number; end: number }[] = [];
  let t = durations[0]! * secPer; // leading pad
  let cur: { ph: string; start: number } | null = null;
  for (let i = 0; i < chars.length; i++) {
    const d = durations[i + 1]! * secPer;
    const c = chars[i]!;
    if (c === " ") {
      if (cur) words.push({ ...cur, end: t });
      cur = null;
    } else {
      cur ??= { ph: "", start: t };
      cur.ph += c;
    }
    t += d;
  }
  if (cur) words.push({ ...cur, end: t });

  const out: WordTiming[] = [];
  for (const w of words) {
    const isPunct = !/[\p{L}\p{N}]/u.test(w.ph);
    if (isPunct && out.length) out[out.length - 1]!.end = w.end;
    else if (!isPunct) out.push({ start: w.start, end: w.end, ph: w.ph });
  }
  return out;
}

type KokoroModule = typeof import("kokoro-js");
type KokoroTTS = Awaited<ReturnType<KokoroModule["KokoroTTS"]["from_pretrained"]>>;
type ModelOutputs = Record<string, { data: ArrayLike<number>; dims: number[] }>;

export interface KokoroOnnxOptions {
  id: string;
  label?: string;
  modelId: string;
  dtype: KokoroDtype;
  /** Where model files are downloaded/cached. */
  modelsDir: string;
}

export class KokoroOnnxBackend implements TtsBackend {
  readonly id: string;
  readonly label: string;
  readonly timing = "native" as const;
  private tts: KokoroTTS | null = null;
  private initPromise: Promise<void> | null = null;
  private lastOutputs: ModelOutputs | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private mod: KokoroModule | null = null;

  constructor(private opts: KokoroOnnxOptions) {
    this.id = opts.id;
    this.label = opts.label ?? `Kokoro 82M (${opts.dtype})`;
  }

  init(onProgress?: (e: ProgressEvent) => void): Promise<void> {
    this.initPromise ??= (async () => {
      const transformers = await import("@huggingface/transformers");
      transformers.env.cacheDir = this.opts.modelsDir;
      transformers.env.allowLocalModels = false;
      this.mod = await import("kokoro-js");
      const tts = await this.mod.KokoroTTS.from_pretrained(this.opts.modelId, {
        dtype: this.opts.dtype,
        device: "cpu",
        progress_callback: onProgress ? (e: unknown) => onProgress(e as ProgressEvent) : undefined,
      } as Parameters<KokoroModule["KokoroTTS"]["from_pretrained"]>[1]);
      // kokoro-js keeps only `waveform`; wrap the model call to also capture `durations`.
      const t = tts as unknown as { model: (inputs: unknown) => Promise<ModelOutputs> };
      const model = t.model;
      t.model = async (inputs: unknown) => {
        const out = await model(inputs);
        this.lastOutputs = out;
        return out;
      };
      this.tts = tts;
    })().catch((e) => {
      this.initPromise = null;
      throw e;
    });
    return this.initPromise;
  }

  async voices(): Promise<VoiceInfo[]> {
    await this.init();
    const v = this.tts!.voices as Record<string, { name: string; language: string; gender: string; overallGrade: string }>;
    return Object.entries(v).map(([id, x]) => ({ id, name: x.name, language: x.language, gender: x.gender, grade: x.overallGrade }));
  }

  defaultVoice(): string {
    return "af_heart";
  }

  private charKnown = new Map<string, boolean>();

  /**
   * The phonemizer can emit characters the tokenizer silently drops (e.g. the
   * combining syllabic mark in "written" → ɹɪʔn̩). Keep only characters that
   * produce a token, so durations line up one-to-one with characters.
   */
  private tokenizable(phonemes: string): string {
    const tok = (this.tts as unknown as { tokenizer: (s: string) => { input_ids: { dims: number[] } } }).tokenizer;
    let out = "";
    for (const ch of phonemes) {
      let known = this.charKnown.get(ch);
      if (known === undefined) {
        known = ch === " " || tok(ch).input_ids.dims.at(-1)! - 2 > 0;
        this.charKnown.set(ch, known);
      }
      if (known) out += ch;
    }
    return out;
  }

  /** ONNX sessions are not re-entrant: run one synthesis at a time. */
  synthesize(req: SynthesisRequest, signal?: AbortSignal): Promise<SynthesisResult> {
    const run = this.queue.then(() => this.run(req, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(req: SynthesisRequest, signal?: AbortSignal): Promise<SynthesisResult> {
    signal?.throwIfAborted();
    await this.init();
    const tts = this.tts!;
    // stream() phonemizes and may split the text into sentences; collect every chunk.
    const splitter = new this.mod!.TextSplitterStream();
    splitter.push(req.text);
    splitter.close();
    const chunks: Float32Array[] = [];
    let words: WordTiming[] | null = [];
    let offset = 0;
    for await (const chunk of tts.stream(splitter, { voice: req.voice as never, speed: req.speed })) {
      signal?.throwIfAborted();
      const audio = chunk.audio.audio as Float32Array;
      const secs = audio.length / SAMPLE_RATE;
      const dur = this.lastOutputs?.durations?.data;
      const w = dur ? durationsToWordTimings(this.tokenizable(chunk.phonemes), dur, secs) : null;
      if (w && words) words.push(...w.map((x) => ({ ...x, start: x.start + offset, end: x.end + offset })));
      else words = null;
      chunks.push(audio);
      offset += secs;
    }
    const pcm = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    return { pcm, sampleRate: SAMPLE_RATE, words };
  }
}
