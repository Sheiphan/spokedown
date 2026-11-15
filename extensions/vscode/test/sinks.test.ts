import { describe, expect, it } from "vitest";
import { AfplaySink } from "../src/sinks.js";

const SR = 24000;
const silence = (sec: number) => new Float32Array(Math.round(sec * SR)); // silent, so the test makes no noise

describe.runIf(process.platform === "darwin")("AfplaySink (macOS)", () => {
  it("plays to the end and reports the full position", async () => {
    const sink = new AfplaySink(() => 0);
    const t0 = performance.now();
    expect(await sink.play(silence(0.4), SR, 0)).toBe("ended");
    expect(performance.now() - t0).toBeGreaterThan(300);
    expect(sink.position()).toBeCloseTo(0.4, 2);
    sink.dispose();
  });

  it("stops early, freezes the position, and resumes from an offset", async () => {
    const sink = new AfplaySink(() => 0);
    const p = sink.play(silence(3), SR, 0);
    await new Promise((r) => setTimeout(r, 500));
    sink.stop();
    expect(await p).toBe("interrupted");
    const pos = sink.position();
    expect(pos).toBeGreaterThan(0.2);
    expect(pos).toBeLessThan(1.5);
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.position()).toBe(pos); // frozen while stopped
    const t0 = performance.now();
    expect(await sink.play(silence(3), SR, 2.6)).toBe("ended"); // only the last 0.4 s plays
    expect(performance.now() - t0).toBeLessThan(1500);
    sink.dispose();
  }, 10_000);
});
