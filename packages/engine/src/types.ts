import type { TimingQuality, WordTiming } from "@spokedown/core";

export interface SynthesisRequest {
  text: string;
  voice: string;
  /** 1 = normal. Engines that support it change speaking rate natively (keeps pitch natural). */
  speed: number;
}

export interface SynthesisResult {
  /** Mono samples in [-1, 1]. */
  pcm: Float32Array;
  sampleRate: number;
  /** Per spoken word (split on spaces), seconds from start of `pcm`; null if the engine has no timings. */
  words: WordTiming[] | null;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  gender?: string;
  /** Quality grade where the model publishes one (Kokoro: A … F). */
  grade?: string;
}

export interface ProgressEvent {
  file?: string;
  /** 0–100 for the current file */
  progress?: number;
  loaded?: number;
  total?: number;
  status: string;
}

export interface TtsBackend {
  readonly id: string;
  readonly label: string;
  /** Whether `synthesize` returns word timings. */
  readonly timing: "native" | "none";
  init(onProgress?: (e: ProgressEvent) => void): Promise<void>;
  voices(): Promise<VoiceInfo[]>;
  defaultVoice(): string;
  synthesize(req: SynthesisRequest, signal?: AbortSignal): Promise<SynthesisResult>;
  dispose?(): Promise<void>;
}

export type KokoroDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

/** User-configurable model entry (VS Code setting `spokedown.models`). */
export type ModelConfig =
  | { id: string; type: "kokoro-onnx"; label?: string; modelId: string; dtype: KokoroDtype }
  | { id: string; type: "openai"; label?: string; baseUrl: string; model: string; apiKey?: string; voices?: string[]; defaultVoice?: string }
  | { id: string; type: "say"; label?: string };

/** Audio for one speech-script segment, ready to play and highlight. */
export interface SegmentAudio {
  pcm: Float32Array;
  sampleRate: number;
  duration: number;
  /** One entry per segment word. */
  timings: WordTiming[];
  quality: TimingQuality;
  cached: boolean;
}
