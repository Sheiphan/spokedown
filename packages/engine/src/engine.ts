import { alignWordTimings, type Word } from "@mdreader/core";
import { AudioCache, cacheKey } from "./cache.js";
import { BUILTIN_MODELS } from "./catalog.js";
import { KokoroOnnxBackend } from "./backends/kokoroOnnx.js";
import { MacSayBackend } from "./backends/macSay.js";
import { OpenAiCompatBackend } from "./backends/openaiCompat.js";
import type { ModelConfig, ProgressEvent, SegmentAudio, SynthesisResult, TtsBackend } from "./types.js";

export interface EngineOptions {
  /** User models; merged over the built-ins (same id replaces). */
  models?: ModelConfig[];
  modelsDir: string;
  cacheDir: string;
  cacheMaxBytes?: number;
  /** Test hook. */
  createBackend?: (config: ModelConfig) => TtsBackend;
}

export interface VoiceSelection {
  modelId: string;
  /** Empty → the backend's default voice. */
  voice?: string;
  speed: number;
}

/** Which part of a model's config affects the audio (for cache keys). */
function audioIdentity(c: ModelConfig): unknown {
  switch (c.type) {
    case "kokoro-onnx": return { t: c.type, m: c.modelId, d: c.dtype };
    case "openai": return { t: c.type, u: c.baseUrl, m: c.model };
    case "say": return { t: c.type };
  }
}

function withAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A synthesis shared by every request for the same audio; cancelled when all of them give up. */
interface Job {
  promise: Promise<SynthesisResult>;
  ac: AbortController;
  waiters: number;
}

export class Engine {
  private configs = new Map<string, ModelConfig>();
  private backends = new Map<string, TtsBackend>();
  private inflight = new Map<string, Job>();
  readonly cache: AudioCache;

  constructor(private opts: EngineOptions) {
    this.cache = new AudioCache(opts.cacheDir, opts.cacheMaxBytes);
    this.setModels(opts.models ?? []);
  }

  /** Replace user models. Backends whose config changed are disposed. */
  setModels(user: ModelConfig[]): void {
    const next = new Map<string, ModelConfig>();
    for (const e of BUILTIN_MODELS) next.set(e.config.id, e.config);
    for (const m of user) next.set(m.id, m);
    for (const [id, b] of this.backends) {
      if (JSON.stringify(next.get(id)) !== JSON.stringify(this.configs.get(id))) {
        void b.dispose?.();
        this.backends.delete(id);
      }
    }
    this.configs = next;
  }

  models(): ModelConfig[] {
    return [...this.configs.values()];
  }

  backend(modelId: string): TtsBackend {
    const existing = this.backends.get(modelId);
    if (existing) return existing;
    const c = this.configs.get(modelId);
    if (!c) throw new Error(`Unknown model "${modelId}". Known: ${[...this.configs.keys()].join(", ")}`);
    const b = this.opts.createBackend?.(c) ?? this.create(c);
    this.backends.set(modelId, b);
    return b;
  }

  private create(c: ModelConfig): TtsBackend {
    switch (c.type) {
      case "kokoro-onnx": return new KokoroOnnxBackend({ ...c, modelsDir: this.opts.modelsDir });
      case "openai": return new OpenAiCompatBackend(c);
      case "say": return new MacSayBackend(c);
    }
  }

  /** Load (and download if needed) a model ahead of playback. */
  prepare(modelId: string, onProgress?: (e: ProgressEvent) => void): Promise<void> {
    return this.backend(modelId).init(onProgress);
  }

  /**
   * Synthesize one speech-script segment and time its words. Results are cached on
   * disk, and concurrent requests for the same audio (play + prefetch) share one job.
   */
  async synthesizeSegment(seg: { text: string; words: Pick<Word, "text">[] }, sel: VoiceSelection, signal?: AbortSignal): Promise<SegmentAudio> {
    const backend = this.backend(sel.modelId);
    const voice = sel.voice || backend.defaultVoice();
    const key = cacheKey({ model: audioIdentity(this.configs.get(sel.modelId)!), voice, speed: sel.speed, text: seg.text });

    let cached = true;
    let result = await this.cache.get(key);
    if (!result) {
      cached = false;
      signal?.throwIfAborted(); // don't start (or join) work nobody wants
      let job = this.inflight.get(key);
      if (!job) {
        const ac = new AbortController();
        const j: Job = { ac, waiters: 0, promise: undefined as unknown as Promise<SynthesisResult> };
        j.promise = backend
          .synthesize({ text: seg.text, voice, speed: sel.speed }, ac.signal)
          .then(async (r) => {
            await this.cache.put(key, r).catch(() => undefined);
            return r;
          })
          .finally(() => {
            if (this.inflight.get(key) === j) this.inflight.delete(key);
          });
        j.promise.catch(() => undefined);
        this.inflight.set(key, j);
        job = j;
      }
      const shared = job;
      shared.waiters++;
      result = await withAbort(shared.promise, signal, () => {
        // last interested caller gone: cancel (a queued Kokoro job never starts)
        if (--shared.waiters === 0) {
          shared.ac.abort();
          if (this.inflight.get(key) === shared) this.inflight.delete(key);
        }
      });
    }
    const duration = result.pcm.length / result.sampleRate;
    const { timings, quality } = alignWordTimings(seg.words, result.words, duration);
    return { pcm: result.pcm, sampleRate: result.sampleRate, duration, timings, quality, cached };
  }

  async dispose(): Promise<void> {
    for (const b of this.backends.values()) await b.dispose?.();
    this.backends.clear();
  }
}
