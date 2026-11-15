import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildSpeechScript } from "@spokedown/core";
import {
  AudioCache, Engine, KokoroOnnxBackend, MacSayBackend, OpenAiCompatBackend,
  decodeWav, durationsToWordTimings, encodeWav, parseSayVoices,
  type ModelConfig, type SynthesisRequest, type SynthesisResult, type TtsBackend,
} from "../src/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "spokedown-test-"));

describe("durationsToWordTimings", () => {
  it("splits on spaces, skips pads, merges punctuation-only runs", () => {
    // phonemes "ab cd ." → 7 chars + 2 pads
    const dur = [2, 1, 1, 1, 1, 1, 1, 1, 1];
    const w = durationsToWordTimings("ab cd .", dur, 1)!;
    const u = 1 / 10;
    expect(w).toHaveLength(2);
    expect(w[0]!.start).toBeCloseTo(2 * u);
    expect(w[0]!.end).toBeCloseTo(4 * u);
    expect(w[1]!.start).toBeCloseTo(5 * u);
    expect(w[1]!.end).toBeCloseTo(9 * u); // "." merged into "cd"
    expect(w[1]!.ph).toBe("cd");
  });
  it("returns null when shapes disagree", () => {
    expect(durationsToWordTimings("abc", [1, 1, 1], 1)).toBeNull();
  });
});

describe("wav", () => {
  it("round-trips 16-bit PCM", () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const out = decodeWav(encodeWav(pcm, 24000));
    expect(out.sampleRate).toBe(24000);
    expect([...out.pcm].map((x) => +x.toFixed(3))).toEqual([0, 0.5, -0.5, 1, -1]);
  });
  it("rejects non-WAV data", () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow(/WAV/);
  });
});

describe("AudioCache", () => {
  const result = (n: number): SynthesisResult => ({ pcm: new Float32Array(n).fill(0.25), sampleRate: 24000, words: [{ start: 0, end: 0.1 }] });
  it("stores and loads results", async () => {
    const c = new AudioCache(tmp());
    expect(await c.get("k")).toBeNull();
    await c.put("k", result(100));
    const r = (await c.get("k"))!;
    expect(r.pcm.length).toBe(100);
    expect(r.pcm[0]).toBeCloseTo(0.25, 3);
    expect(r.words).toEqual([{ start: 0, end: 0.1 }]);
  });
  it("evicts oldest entries beyond the size limit", async () => {
    const dir = tmp();
    const c = new AudioCache(dir, 5000);
    for (let i = 0; i < 6; i++) {
      await c.put(`k${i}`, result(1000)); // ~2 KB each
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(await c.sizeBytes()).toBeLessThanOrEqual(5000);
    expect(await c.get("k5")).not.toBeNull();
    expect(await c.get("k0")).toBeNull();
  });
});

class FakeBackend implements TtsBackend {
  readonly timing = "native" as const;
  calls: SynthesisRequest[] = [];
  signals: (AbortSignal | undefined)[] = [];
  disposed = false;
  constructor(readonly id: string, readonly label = id, private delayMs = 20) {}
  async init() {}
  async voices() { return [{ id: "v1", name: "V1", language: "en-us" }]; }
  defaultVoice() { return "v1"; }
  async synthesize(req: SynthesisRequest, signal?: AbortSignal): Promise<SynthesisResult> {
    this.calls.push(req);
    this.signals.push(signal);
    await new Promise((r) => setTimeout(r, this.delayMs));
    const words = req.text.split(" ").map((_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4, ph: "xx" }));
    return { pcm: new Float32Array(24000 * words.length * 0.5), sampleRate: 24000, words };
  }
  async dispose() { this.disposed = true; }
}

describe("Engine", () => {
  const make = (models: ModelConfig[] = [], delayMs = 20) => {
    const fakes = new Map<string, FakeBackend>();
    const engine = new Engine({
      models,
      modelsDir: tmp(),
      cacheDir: tmp(),
      createBackend: (c) => {
        const f = new FakeBackend(c.id, c.id, delayMs);
        fakes.set(c.id, f);
        return f;
      },
    });
    return { engine, fakes };
  };
  const seg = { text: "hello big world.", words: [{ text: "hello" }, { text: "big" }, { text: "world." }] };

  it("includes built-in models and lets user models override them", () => {
    const { engine } = make([{ id: "system", type: "say", label: "Mine" }, { id: "srv", type: "openai", baseUrl: "http://x", model: "m" }]);
    const ids = engine.models().map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["kokoro", "kokoro-compact", "system", "srv"]));
    expect(engine.models().find((m) => m.id === "system")!.label).toBe("Mine");
  });

  it("synthesizes, aligns, then serves from cache", async () => {
    const { engine, fakes } = make();
    const a = await engine.synthesizeSegment(seg, { modelId: "kokoro", speed: 1 });
    expect(a.cached).toBe(false);
    expect(a.quality).toBe("native");
    expect(a.timings).toHaveLength(3);
    expect(a.duration).toBeCloseTo(1.5);
    expect(fakes.get("kokoro")!.calls[0]!.voice).toBe("v1");
    const b = await engine.synthesizeSegment(seg, { modelId: "kokoro", speed: 1 });
    expect(b.cached).toBe(true);
    expect(fakes.get("kokoro")!.calls).toHaveLength(1);
  });

  it("keys the cache on voice and speed", async () => {
    const { engine, fakes } = make();
    await engine.synthesizeSegment(seg, { modelId: "kokoro", speed: 1 });
    await engine.synthesizeSegment(seg, { modelId: "kokoro", speed: 1.25 });
    await engine.synthesizeSegment(seg, { modelId: "kokoro", voice: "v2", speed: 1 });
    expect(fakes.get("kokoro")!.calls).toHaveLength(3);
  });

  it("shares one job between concurrent requests (play + prefetch)", async () => {
    const { engine, fakes } = make();
    const [x, y] = await Promise.all([
      engine.synthesizeSegment(seg, { modelId: "kokoro", speed: 1 }),
      engine.synthesizeSegment(seg, { modelId: "kokoro", speed: 1 }),
    ]);
    expect(fakes.get("kokoro")!.calls).toHaveLength(1);
    expect(x.duration).toBe(y.duration);
  });

  it("aborting one waiter does not cancel the shared job", async () => {
    const { engine, fakes } = make();
    const ac = new AbortController();
    const p1 = engine.synthesizeSegment(seg, { modelId: "kokoro", speed: 1 }, ac.signal);
    const p2 = engine.synthesizeSegment(seg, { modelId: "kokoro", speed: 1 });
    ac.abort();
    await expect(p1).rejects.toThrow();
    await expect(p2).resolves.toBeTruthy();
    expect(fakes.get("kokoro")!.calls).toHaveLength(1);
  });

  it("cancels a job once every waiter has aborted", async () => {
    const { engine, fakes } = make([], 300);
    const ac = new AbortController();
    const p = engine.synthesizeSegment(seg, { modelId: "kokoro", speed: 1 }, ac.signal);
    await vi.waitFor(() => expect(fakes.get("kokoro")?.calls).toHaveLength(1), { interval: 5 });
    ac.abort();
    await expect(p).rejects.toThrow();
    // a fresh request starts a new job instead of joining the cancelled one
    await expect(engine.synthesizeSegment(seg, { modelId: "kokoro", speed: 1 })).resolves.toBeTruthy();
    expect(fakes.get("kokoro")!.signals[0]!.aborted).toBe(true);
    expect(fakes.get("kokoro")!.calls).toHaveLength(2);
  });

  it("disposes a backend when its config changes", async () => {
    const { engine, fakes } = make([{ id: "srv", type: "openai", baseUrl: "http://a", model: "m" }]);
    engine.backend("srv");
    engine.setModels([{ id: "srv", type: "openai", baseUrl: "http://b", model: "m" }]);
    expect(fakes.get("srv")!.disposed).toBe(true);
  });

  it("rejects unknown models", () => {
    const { engine } = make();
    expect(() => engine.backend("nope")).toThrow(/Unknown model/);
  });
});

describe("OpenAiCompatBackend", () => {
  it("posts the OpenAI speech request and decodes WAV", async () => {
    let seen: { url: string; body: Record<string, unknown>; auth?: string } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization };
      return new Response(encodeWav(new Float32Array(2400), 24000));
    }) as unknown as typeof fetch;
    const b = new OpenAiCompatBackend({ id: "s", baseUrl: "http://localhost:8000/v1/", model: "m1", apiKey: "k", fetch: fakeFetch });
    const r = await b.synthesize({ text: "hi", voice: "af_bella", speed: 1.2 });
    expect(seen!.url).toBe("http://localhost:8000/v1/audio/speech");
    expect(seen!.body).toEqual({ model: "m1", input: "hi", voice: "af_bella", speed: 1.2, response_format: "wav" });
    expect(seen!.auth).toBe("Bearer k");
    expect(r.pcm.length).toBe(2400);
    expect(r.words).toBeNull();
  });
  it("surfaces HTTP errors", async () => {
    const fakeFetch = (async () => new Response("model not loaded", { status: 500 })) as unknown as typeof fetch;
    const b = new OpenAiCompatBackend({ id: "s", baseUrl: "http://x", model: "m", fetch: fakeFetch });
    await expect(b.synthesize({ text: "hi", voice: "v", speed: 1 })).rejects.toThrow(/HTTP 500 model not loaded/);
  });
});

describe("macOS say", () => {
  it("parses the voice list", () => {
    const v = parseSayVoices("Albert              en_US    # Hello! My name is Albert.\nEddy (English (UK)) en_GB    # Hello!\nbad line\n");
    expect(v).toEqual([
      { id: "Albert", name: "Albert", language: "en-US" },
      { id: "Eddy (English (UK))", name: "Eddy (English (UK))", language: "en-GB" },
    ]);
  });
  it.runIf(process.platform === "darwin")("synthesizes with the system voice", async () => {
    const b = new MacSayBackend({ id: "system" });
    const r = await b.synthesize({ text: "Hello there.", voice: "", speed: 1 });
    expect(r.sampleRate).toBe(24000);
    expect(r.pcm.length / r.sampleRate).toBeGreaterThan(0.3);
  }, 20_000);
});

// Real Kokoro run — only when the model is already downloaded (no network in tests).
const modelsDir = path.join(os.homedir(), ".cache/spokedown/models");
const haveKokoro = fs.existsSync(path.join(modelsDir, "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/onnx/model.onnx"));
describe.runIf(haveKokoro)("Kokoro ONNX (integration)", () => {
  it("gives native word timings for every segment of a real paragraph", async () => {
    const src = await fsp.readFile(path.join(__dirname, "../../core/test/fixtures/docs/softmax-walkthrough.md"), "utf8");
    const segs = (await buildSpeechScript(src)).segments.slice(3, 6);
    const engine = new Engine({ modelsDir, cacheDir: tmp() });
    for (const s of segs) {
      const a = await engine.synthesizeSegment(s, { modelId: "kokoro", speed: 1 });
      expect(a.quality).toBe("native");
      expect(a.timings).toHaveLength(s.words.length);
      for (let i = 1; i < a.timings.length; i++) expect(a.timings[i]!.start).toBeGreaterThanOrEqual(a.timings[i - 1]!.start);
      expect(a.timings.at(-1)!.end).toBeLessThanOrEqual(a.duration + 0.01);
    }
  }, 120_000);

  it("speaks faster at speed 1.5", async () => {
    const b = new KokoroOnnxBackend({ id: "k", modelId: "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped", dtype: "fp32", modelsDir });
    const text = "The quick brown fox jumps over the lazy dog.";
    const n = await b.synthesize({ text, voice: "af_heart", speed: 1 });
    const f = await b.synthesize({ text, voice: "af_heart", speed: 1.5 });
    expect(f.pcm.length).toBeLessThan(n.pcm.length * 0.8);
  }, 60_000);
});
