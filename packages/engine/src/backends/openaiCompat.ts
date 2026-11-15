// Any OpenAI-compatible speech server: mlx-audio (`mlx_audio.server`), Kokoro-FastAPI,
// Orpheus-FastAPI, … POST {baseUrl}/v1/audio/speech → WAV. No word timings.
import type { ProgressEvent, SynthesisRequest, SynthesisResult, TtsBackend, VoiceInfo } from "../types.js";
import { decodeWav } from "../wav.js";

export interface OpenAiCompatOptions {
  id: string;
  label?: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  voices?: string[];
  defaultVoice?: string;
  fetch?: typeof fetch;
}

export class OpenAiCompatBackend implements TtsBackend {
  readonly id: string;
  readonly label: string;
  readonly timing = "none" as const;
  private fetchImpl: typeof fetch;

  constructor(private opts: OpenAiCompatOptions) {
    this.id = opts.id;
    this.label = opts.label ?? `${opts.model} @ ${opts.baseUrl}`;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private url(p: string): string {
    return this.opts.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + p;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) };
  }

  async init(_onProgress?: (e: ProgressEvent) => void): Promise<void> {
    // Nothing to download; reachability is reported by the first synthesize call.
  }

  async voices(): Promise<VoiceInfo[]> {
    if (this.opts.voices?.length) return this.opts.voices.map((id) => ({ id, name: id, language: "" }));
    try {
      // Kokoro-FastAPI exposes this; others may not.
      const r = await this.fetchImpl(this.url("/v1/audio/voices"), { headers: this.headers(), signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const body = (await r.json()) as { voices?: (string | { id?: string; name?: string })[] };
        const list = (body.voices ?? []).map((v) => (typeof v === "string" ? v : v.id ?? v.name ?? "")).filter(Boolean);
        if (list.length) return list.map((id) => ({ id, name: id, language: "" }));
      }
    } catch {
      /* fall through */
    }
    return [{ id: this.defaultVoice(), name: this.defaultVoice(), language: "" }];
  }

  defaultVoice(): string {
    return this.opts.defaultVoice ?? this.opts.voices?.[0] ?? "af_heart";
  }

  async synthesize(req: SynthesisRequest, signal?: AbortSignal): Promise<SynthesisResult> {
    const r = await this.fetchImpl(this.url("/v1/audio/speech"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: this.opts.model, input: req.text, voice: req.voice, speed: req.speed, response_format: "wav" }),
      signal,
    });
    if (!r.ok) throw new Error(`${this.label}: HTTP ${r.status} ${await r.text().catch(() => "")}`.trim());
    const { pcm, sampleRate } = decodeWav(new Uint8Array(await r.arrayBuffer()));
    return { pcm, sampleRate, words: null };
  }
}
