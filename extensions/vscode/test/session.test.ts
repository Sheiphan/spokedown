import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSpeechScript, type Segment, type SpeechScript } from "@mdreader/core";
import type { SegmentAudio } from "@mdreader/engine";
import { ReadingSession, type SessionUpdate } from "../src/session.js";
import { SilentSink } from "../src/sinks.js";

const DOC = `# One

First sentence here. Second sentence here.

| a | b |
|---|---|
| 1 | 2 |
| 3 | 4 |

## Two

Third part.
`;

const WORD_SEC = 0.25;

function fakeAudio(seg: Segment): SegmentAudio {
  const n = seg.words.length;
  const sr = 100;
  return {
    pcm: new Float32Array(Math.round(n * WORD_SEC * sr)),
    sampleRate: sr,
    duration: n * WORD_SEC,
    timings: seg.words.map((_, i) => ({ start: i * WORD_SEC, end: (i + 1) * WORD_SEC })),
    quality: "native",
    cached: false,
  };
}

let script: SpeechScript;
beforeEach(async () => {
  script = await buildSpeechScript(DOC, { pauses: { heading: 0, afterHeading: 0, paragraph: 0, block: 0, thematicBreak: 0 } });
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function setup(opts: { synthDelay?: number; fail?: number; range?: { from: number; to: number } } = {}) {
  const updates: SessionUpdate[] = [];
  const errors: unknown[] = [];
  const synthCalls: number[] = [];
  const aborted: number[] = [];
  const sink = new SilentSink(() => Date.now());
  const session = new ReadingSession(
    script,
    {
      synth: (seg, signal) => {
        synthCalls.push(seg.id);
        signal.addEventListener("abort", () => aborted.push(seg.id));
        if (seg.id === opts.fail) return Promise.reject(new Error("boom"));
        return new Promise((r) => setTimeout(() => r(fakeAudio(seg)), opts.synthDelay ?? 10));
      },
      sink,
      onUpdate: (u) => updates.push(u),
      onError: (e) => errors.push(e),
      prefetch: () => 2,
      leadSec: () => 0,
      tickMs: 20,
    },
    opts.range,
  );
  const spoken = () => updates.filter((u) => u.state === "playing" && u.word >= 0).map((u) => u.segment!.words[u.word]!.text);
  return { session, updates, errors, synthCalls, aborted, spoken };
}

describe("ReadingSession", () => {
  it("reads every segment, highlighting each word in order, then finishes", async () => {
    const { session, updates, spoken } = setup();
    session.start(0);
    await vi.runAllTimersAsync();
    const allWords = script.segments.flatMap((s) => s.words.map((w) => w.text));
    expect(spoken()).toEqual(allWords);
    const last = updates.at(-1)!;
    expect(last.state).toBe("idle");
    expect(last.finished).toBe(true);
  });

  it("can start mid-sentence at a given word", async () => {
    const { session, spoken } = setup();
    session.start(1, 2); // "First sentence here." from "here."
    await vi.advanceTimersByTimeAsync(10 + WORD_SEC * 1000 * 0.5);
    expect(spoken()[0]).toBe("here.");
    session.stop();
  });

  it("shows loading while the first segment is synthesized", async () => {
    const { session, updates } = setup({ synthDelay: 500 });
    session.start(0);
    expect(updates.at(-1)!.state).toBe("loading");
    await vi.advanceTimersByTimeAsync(510);
    expect(updates.at(-1)!.state).toBe("playing");
    session.stop();
  });

  it("prefetches ahead and cancels synthesis it no longer needs", async () => {
    const { session, synthCalls, aborted } = setup({ synthDelay: 1000 });
    session.start(0);
    expect(synthCalls).toEqual([0, 1, 2]);
    session.seek(6); // far away: old prefetches are dropped
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toEqual(expect.arrayContaining([1, 2]));
    expect(synthCalls).toEqual(expect.arrayContaining([6]));
    session.stop();
  });

  it("pauses and resumes at the same word", async () => {
    const { session, updates } = setup();
    session.start(1); // "First sentence here."
    await vi.advanceTimersByTimeAsync(10 + WORD_SEC * 1000 * 1.5); // into word 2
    session.pause();
    const paused = updates.at(-1)!;
    expect(paused.state).toBe("paused");
    expect(paused.index).toBe(1);
    expect(paused.word).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); // nothing moves while paused
    expect(updates.at(-1)).toBe(paused);
    session.resume();
    await vi.advanceTimersByTimeAsync(5);
    const resumed = updates.filter((u) => u.state === "playing").at(-1)!;
    expect(resumed.index).toBe(1);
    expect(resumed.word).toBe(1);
    await vi.advanceTimersByTimeAsync(WORD_SEC * 1000);
    expect(updates.at(-1)!.word).toBe(2);
    session.stop();
  });

  it("moves between sentences and headings", async () => {
    const { session, updates } = setup();
    session.start(1);
    await vi.advanceTimersByTimeAsync(50);
    session.nextSentence();
    await vi.advanceTimersByTimeAsync(50);
    expect(updates.at(-1)!.index).toBe(2);
    session.nextHeading();
    await vi.advanceTimersByTimeAsync(50);
    expect(updates.at(-1)!.segment!.text).toBe("Two.");
    session.previousHeading();
    await vi.advanceTimersByTimeAsync(50);
    expect(updates.at(-1)!.segment!.text).toBe("One.");
    session.stop();
  });

  it("previous sentence restarts the current one when well into it", async () => {
    const { session, updates } = setup();
    session.start(2);
    await vi.advanceTimersByTimeAsync(10 + 2000);
    session.previousSentence();
    await vi.advanceTimersByTimeAsync(30);
    expect(updates.at(-1)!.index).toBe(2);
    session.previousSentence();
    await vi.advanceTimersByTimeAsync(30);
    expect(updates.at(-1)!.index).toBe(1);
    session.stop();
  });

  it("skips a whole table at once", async () => {
    const { session, updates } = setup();
    const intro = script.segments.findIndex((s) => s.kind === "tableIntro");
    session.start(intro + 1); // first row
    await vi.advanceTimersByTimeAsync(30);
    session.skipBlock();
    await vi.advanceTimersByTimeAsync(30);
    expect(updates.at(-1)!.segment!.text).toBe("Two.");
    session.stop();
  });

  it("navigates while paused without starting playback", async () => {
    const { session, updates } = setup();
    session.start(1);
    await vi.advanceTimersByTimeAsync(30);
    session.pause();
    session.nextSentence();
    expect(updates.at(-1)!.state).toBe("paused");
    expect(updates.at(-1)!.index).toBe(2);
    session.resume();
    await vi.advanceTimersByTimeAsync(30);
    expect(updates.at(-1)!.index).toBe(2);
    expect(updates.at(-1)!.state).toBe("playing");
    session.stop();
  });

  it("stops at the end of a selection range", async () => {
    const { session, updates } = setup({ range: { from: 1, to: 3 } });
    session.start(1);
    await vi.runAllTimersAsync();
    const played = new Set(updates.filter((u) => u.state === "playing").map((u) => u.index));
    expect([...played]).toEqual([1, 2]);
    expect(updates.at(-1)!.finished).toBe(true);
  });

  it("reports synthesis errors and goes idle", async () => {
    const { session, updates, errors } = setup({ fail: 1 });
    session.start(1);
    await vi.runAllTimersAsync();
    expect(errors).toHaveLength(1);
    expect(updates.at(-1)!.state).toBe("idle");
  });

  it("re-synthesizes upcoming audio after a voice or speed change", async () => {
    const { session, synthCalls } = setup({ synthDelay: 10 });
    session.start(0);
    await vi.advanceTimersByTimeAsync(50);
    const before = synthCalls.length;
    session.invalidateUpcoming();
    expect(synthCalls.length).toBeGreaterThan(before);
    expect(synthCalls.slice(before)).toEqual([1, 2]);
    session.stop();
  });
});
