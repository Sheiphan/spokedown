// Playback state machine: synthesizes ahead, plays segment by segment, tracks the
// spoken word, and handles pause / seek / navigation. No vscode imports (unit-testable).
import { wordIndexAt, type Segment, type SpeechScript, type TimingQuality } from "@spokedown/core";
import type { SegmentAudio } from "@spokedown/engine";

export interface AudioSink {
  /** Play `pcm` from `startSec`. Resolves "ended" at the natural end, "interrupted" after stop(). */
  play(pcm: Float32Array, sampleRate: number, startSec: number): Promise<"ended" | "interrupted">;
  stop(): void;
  /** Seconds into the buffer being played (including startSec); the last position after stop(). */
  position(): number;
  dispose?(): void;
}

export type PlayState = "idle" | "loading" | "playing" | "paused";

export interface SessionUpdate {
  state: PlayState;
  index: number;
  /** Word being spoken in the current segment, -1 if none yet. */
  word: number;
  segment: Segment | undefined;
  quality?: TimingQuality;
  /** True on the final update after the last segment finished. */
  finished?: boolean;
}

export interface SessionDeps {
  synth(seg: Segment, signal: AbortSignal): Promise<SegmentAudio>;
  sink: AudioSink;
  onUpdate(u: SessionUpdate): void;
  onError(e: unknown): void;
  /** Number of segments to synthesize ahead. */
  prefetch(): number;
  /** Seconds the word highlight leads the audio. */
  leadSec(): number;
  sleep?(ms: number): Promise<void>;
  tickMs?: number;
}

interface Pending {
  promise: Promise<SegmentAudio>;
  ac: AbortController;
  done: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ReadingSession {
  private index = 0;
  private word = -1;
  private state: PlayState = "idle";
  private gen = 0;
  private audio = new Map<number, Pending>();
  private current: SegmentAudio | undefined;
  private pausedAt = 0;
  /** Start the next loop at this word of segment `seekIndex` instead of its beginning. */
  private seekWord = -1;
  private seekIndex = -1;
  /** Lowest word index the highlight may show for the segment playing (the word we seeked to). */
  private floorWord = -1;
  private ticker: ReturnType<typeof setInterval> | undefined;
  /** Exclusive end segment (Read Selection stops early). */
  private end: number;

  constructor(private script: SpeechScript, private d: SessionDeps, range?: { from: number; to: number }) {
    this.end = Math.min(range?.to ?? script.segments.length, script.segments.length);
    this.index = range?.from ?? 0;
  }

  get segments(): Segment[] {
    return this.script.segments;
  }

  snapshot(): SessionUpdate {
    return { state: this.state, index: this.index, word: this.word, segment: this.script.segments[this.index], quality: this.current?.quality };
  }

  // ---------- transport ----------

  /** Start reading at segment `index`, optionally mid-sentence at `word`. */
  start(index = this.index, word = 0): void {
    this.seekIndex = word > 0 ? index : -1;
    this.seekWord = word;
    this.jump(index, 0);
  }

  pause(): void {
    if (this.state !== "playing" && this.state !== "loading") return;
    this.pausedAt = this.state === "playing" ? this.d.sink.position() : 0;
    this.gen++;
    this.d.sink.stop();
    this.stopTicker();
    this.set("paused");
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.jump(this.index, this.pausedAt, this.word);
  }

  toggle(): void {
    if (this.state === "paused") this.resume();
    else if (this.state === "playing" || this.state === "loading") this.pause();
    else this.start();
  }

  stop(): void {
    this.gen++;
    this.d.sink.stop();
    this.stopTicker();
    for (const p of this.audio.values()) if (!p.done) p.ac.abort();
    this.audio.clear();
    this.word = -1;
    this.set("idle");
  }

  // ---------- navigation ----------

  nextSentence(): void {
    this.seek(this.index + 1);
  }

  previousSentence(): void {
    // like a music player: restart the sentence unless we're at its very beginning
    const into = this.state === "playing" ? this.d.sink.position() : this.state === "paused" ? this.pausedAt : 0;
    this.seek(into > 1.5 ? this.index : this.index - 1);
  }

  nextHeading(): void {
    const h = this.script.headings.find((x) => x.segmentId > this.index);
    if (h) this.seek(h.segmentId);
  }

  previousHeading(): void {
    const before = this.script.headings.filter((x) => x.segmentId <= this.index);
    let h = before.at(-1);
    // already at the heading itself → go one further back
    if (h && h.segmentId === this.index && before.length > 1) h = before.at(-2);
    if (h) this.seek(h.segmentId);
  }

  /** Jump past the current block (whole table, code block, list item…). */
  skipBlock(): void {
    const cur = this.script.segments[this.index];
    if (!cur) return;
    const next = this.script.segments.findIndex((s, i) => i > this.index && s.blockRange[0] >= cur.blockRange[1]);
    this.seek(next < 0 ? this.end : next);
  }

  /** Start at segment `index`, keeping the paused/playing state. */
  seek(index: number): void {
    const i = Math.max(0, Math.min(index, this.end));
    if (this.state === "paused" || this.state === "idle") {
      this.index = Math.min(i, this.end - 1);
      this.pausedAt = 0;
      this.word = -1;
      this.current = undefined;
      this.emit();
      if (this.state === "idle") this.start(this.index);
      return;
    }
    this.jump(i, 0);
  }

  /** Voice/speed/model changed: re-synthesize everything not yet playing. */
  invalidateUpcoming(): void {
    for (const [i, p] of this.audio) {
      if (i === this.index && this.state === "playing") continue;
      if (!p.done) p.ac.abort();
      this.audio.delete(i);
    }
    if (this.state === "playing") this.prefetchAhead(this.index);
  }

  dispose(): void {
    this.stop();
  }

  // ---------- internals ----------

  private set(state: PlayState, extra: Partial<SessionUpdate> = {}): void {
    this.state = state;
    this.emit(extra);
  }

  private emit(extra: Partial<SessionUpdate> = {}): void {
    this.d.onUpdate({ ...this.snapshot(), ...extra });
  }

  private fetch(i: number): Promise<SegmentAudio> {
    let p = this.audio.get(i);
    if (!p) {
      const ac = new AbortController();
      const entry: Pending = { ac, done: false, promise: undefined as unknown as Promise<SegmentAudio> };
      entry.promise = this.d.synth(this.script.segments[i]!, ac.signal).then((a) => {
        entry.done = true;
        return a;
      });
      entry.promise.catch(() => undefined); // prefetch failures surface when (if) the segment is reached
      this.audio.set(i, entry);
      p = entry;
    }
    return p.promise;
  }

  private prefetchAhead(i: number): void {
    const n = this.d.prefetch();
    for (let j = i + 1; j <= i + n && j < this.end; j++) this.fetch(j);
  }

  /** Keep the previous segment (for "previous sentence") and the prefetch window. */
  private prune(i: number): void {
    const n = this.d.prefetch();
    for (const [j, p] of this.audio) {
      if (j < i - 1 || j > i + n) {
        if (!p.done) p.ac.abort();
        this.audio.delete(j);
      }
    }
  }

  private jump(index: number, startSec: number, word = -1): void {
    const gen = ++this.gen;
    this.d.sink.stop();
    this.stopTicker();
    this.index = Math.max(0, Math.min(index, this.end));
    this.word = word;
    void this.loop(gen, startSec);
  }

  private async loop(gen: number, startSec: number): Promise<void> {
    const sleep = this.d.sleep ?? defaultSleep;
    try {
      while (gen === this.gen && this.index < this.end) {
        const i = this.index;
        const seg = this.script.segments[i]!;
        this.prune(i);
        const pending = this.fetch(i);
        this.prefetchAhead(i);
        if (!this.audio.get(i)!.done) this.set("loading");
        const audio = await pending;
        if (gen !== this.gen) return;
        this.current = audio;
        this.floorWord = -1;
        if (this.seekIndex === i && this.seekWord > 0 && audio.timings[this.seekWord]) {
          // begin just before the requested word (no lead-in pause)
          startSec = Math.max(0, audio.timings[this.seekWord]!.start - 0.03);
          this.floorWord = this.seekWord;
        }
        this.seekIndex = -1;

        if (startSec === 0 && seg.pauseBefore > 0) {
          this.word = -1;
          this.set("playing");
          await sleep(seg.pauseBefore);
          if (gen !== this.gen) return;
        }
        this.set("playing");
        const playing = this.d.sink.play(audio.pcm, audio.sampleRate, startSec); // resets the sink clock first
        this.startTicker(gen);
        const res = await playing;
        this.stopTicker();
        if (gen !== this.gen || res === "interrupted") return;
        if (seg.pauseAfter > 0) {
          await sleep(seg.pauseAfter);
          if (gen !== this.gen) return;
        }
        startSec = 0;
        this.index++;
        this.word = -1;
      }
      if (gen === this.gen) {
        this.index = Math.min(this.index, this.end - 1);
        this.word = -1;
        this.audio.clear();
        this.set("idle", { finished: true });
      }
    } catch (e) {
      if (gen !== this.gen) return; // aborted by navigation
      this.gen++;
      this.stopTicker();
      this.set("idle");
      this.d.onError(e);
    }
  }

  private startTicker(gen: number): void {
    this.stopTicker();
    const tick = () => {
      if (gen !== this.gen || this.state !== "playing" || !this.current) return;
      const w = Math.max(this.floorWord, wordIndexAt(this.current.timings, this.d.sink.position() + this.d.leadSec()));
      if (w !== this.word) {
        this.word = w;
        this.emit();
      }
    };
    tick();
    this.ticker = setInterval(tick, this.d.tickMs ?? 40);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
