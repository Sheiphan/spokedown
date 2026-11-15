import type { ModelConfig } from "./types.js";

export interface CatalogEntry {
  config: ModelConfig;
  description: string;
  /** Download size in MB, if the model is downloaded locally. */
  sizeMB?: number;
  license: string;
  wordTimings: "exact" | "estimated";
}

/** Built-in models, always available. Measured on an M4 Pro: fp32 8.6× real time, q8 3.3×. */
export const BUILTIN_MODELS: CatalogEntry[] = [
  {
    config: { id: "kokoro", type: "kokoro-onnx", label: "Kokoro 82M", modelId: "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped", dtype: "fp32" },
    description: "Natural English voices, exact word highlighting. Fastest on Apple Silicon CPUs.",
    sizeMB: 326,
    license: "Apache-2.0",
    wordTimings: "exact",
  },
  {
    config: { id: "kokoro-compact", type: "kokoro-onnx", label: "Kokoro 82M (compact)", modelId: "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped", dtype: "q8" },
    description: "Same voices, 8-bit weights: smaller download, about 2.5× slower to generate.",
    sizeMB: 92,
    license: "Apache-2.0",
    wordTimings: "exact",
  },
  {
    config: { id: "system", type: "say", label: "macOS system voice" },
    description: "Built-in macOS voices. Nothing to download; sentence-level highlighting only.",
    license: "macOS",
    wordTimings: "estimated",
  },
];

/** Starting points for "Add model": servers the user runs themselves. */
export const MODEL_TEMPLATES: CatalogEntry[] = [
  {
    config: { id: "mlx-audio", type: "openai", label: "mlx-audio server", baseUrl: "http://localhost:8000", model: "mlx-community/Kokoro-82M-bf16" },
    description: "Any mlx-audio model on Apple Silicon (Qwen3-TTS, Chatterbox, Dia, …). Run: uvx --from mlx-audio mlx_audio.server",
    license: "per model",
    wordTimings: "estimated",
  },
  {
    config: { id: "kokoro-fastapi", type: "openai", label: "Kokoro-FastAPI", baseUrl: "http://localhost:8880", model: "kokoro" },
    description: "Kokoro-FastAPI server (Docker). OpenAI-compatible.",
    license: "Apache-2.0",
    wordTimings: "estimated",
  },
];

export const DEFAULT_MODEL_ID = "kokoro";
