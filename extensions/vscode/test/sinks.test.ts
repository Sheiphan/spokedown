import { describe, expect, it } from "vitest";
import { PlayerSink } from "../src/sinks.js";

const SR = 24000;
const silence = (sec: number) => new Float32Array(Math.round(sec * SR)); // silent, so the test makes no noise

describe.runIf(process.platform === "darwin")("PlayerSink (macOS afplay)", () => {
  it("plays to the end and reports the full position", async () => {
    const sink = new PlayerSink(() => 0);
    const t0 = performance.now();
    expect(await sink.play(silence(0.4), SR, 0)).toBe("ended");
    expect(performance.now() - t0).toBeGreaterThan(300);
    expect(sink.position()).toBeCloseTo(0.4, 2);
    sink.dispose();
  });

  it("stops early, freezes the position, and resumes from an offset", async () => {
    const sink = new PlayerSink(() => 0);
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
    expect(performance.now() - t0).toBeLessThan(2500); // the whole 3 s would take ≥ 3 s; headroom for slow afplay start-up on CI
    sink.dispose();
  }, 10_000);
});

// The same sink logic, driven by a fake player program, so it is covered on every platform.
import { READY_MARKER, type PlayerResult } from "../src/players.js";

const fake = (script: string, readyMarker?: string): (() => PlayerResult) => () => ({
  ok: true,
  name: "fake-player",
  player: { command: process.execPath, args: ["-e", script], readyMarker },
});

describe("PlayerSink with a fake player", () => {
  it("starts the clock only when the player says sound begins", async () => {
    // Prints the marker after 400 ms, then plays for 600 ms.
    const script = `setTimeout(()=>{console.log("${READY_MARKER}");setTimeout(()=>{},600)},400)`;
    let t = 0;
    const sink = new PlayerSink(() => 0, () => t, fake(script, READY_MARKER));
    const p = sink.play(silence(5), SR, 1);
    await new Promise((r) => setTimeout(r, 200));
    t = 100_000; // time passes, but the player has not reported readiness yet
    expect(sink.position()).toBe(1); // still at the start offset
    await new Promise((r) => setTimeout(r, 400)); // marker arrives
    t += 2000; // 2 s of clock after sound started
    expect(sink.position()).toBeCloseTo(3, 1);
    sink.stop();
    expect(await p).toBe("interrupted");
    sink.dispose();
  }, 10_000);

  it("rejects when the player exits with an error, instead of racing through the document", async () => {
    const sink = new PlayerSink(() => 0, undefined, fake(`console.error("no sound card");process.exit(3)`));
    await expect(sink.play(silence(2), SR, 0)).rejects.toThrow(/fake-player failed \(exit 3\): no sound card/);
    sink.dispose();
  });

  it("reports a missing player with the resolver's message", async () => {
    const sink = new PlayerSink(() => 0, undefined, () => ({ ok: false, error: "No audio player found." }));
    await expect(sink.play(silence(1), SR, 0)).rejects.toThrow("No audio player found.");
    sink.dispose();
  });
});
