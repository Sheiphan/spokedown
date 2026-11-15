// Audio outputs. afplay: native macOS playback (no webview, so no "click to enable
// audio" gate); pause/seek restart from an exact sample offset of the in-memory PCM.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeWav } from "@mdreader/engine";
import type { AudioSink } from "./session.js";

export class AfplaySink implements AudioSink {
  private proc: ChildProcess | undefined;
  private playId = 0;
  private startSec = 0;
  private duration = 0;
  private t0 = 0;
  private frozen = 0;
  private n = 0;
  private dir: Promise<string>;

  constructor(private latencySec: () => number, private now: () => number = () => performance.now()) {
    this.dir = fs.mkdtemp(path.join(os.tmpdir(), "mdreader-play-"));
  }

  async play(pcm: Float32Array, sampleRate: number, startSec: number): Promise<"ended" | "interrupted"> {
    this.stop();
    const id = ++this.playId;
    const from = Math.max(0, Math.min(Math.floor(startSec * sampleRate), pcm.length));
    const slice = pcm.subarray(from);
    this.startSec = from / sampleRate;
    this.duration = slice.length / sampleRate;
    this.frozen = this.startSec;
    const file = path.join(await this.dir, `seg-${this.n++ % 4}.wav`);
    await fs.writeFile(file, encodeWav(slice, sampleRate));
    if (id !== this.playId) return "interrupted"; // stopped while writing

    return new Promise((resolve, reject) => {
      const p = spawn("afplay", [file], { stdio: "ignore" });
      this.proc = p;
      this.t0 = this.now();
      p.once("error", (e) => {
        if (this.proc === p) this.proc = undefined;
        reject(new Error(`Could not start afplay: ${e.message}`));
      });
      p.once("exit", () => {
        const interrupted = id !== this.playId;
        if (this.proc === p) {
          this.frozen = this.startSec + this.duration;
          this.proc = undefined;
        }
        resolve(interrupted ? "interrupted" : "ended");
      });
    });
  }

  stop(): void {
    if (this.proc) this.frozen = this.position();
    this.playId++;
    this.proc?.kill("SIGKILL");
    this.proc = undefined;
  }

  position(): number {
    if (!this.proc) return this.frozen;
    const elapsed = (this.now() - this.t0) / 1000 - this.latencySec();
    return this.startSec + Math.max(0, Math.min(elapsed, this.duration));
  }

  dispose(): void {
    this.stop();
    void this.dir.then((d) => fs.rm(d, { recursive: true, force: true }));
  }
}

/** Runs the clock without sound — for tests and for checking highlighting quietly. */
export class SilentSink implements AudioSink {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolve: ((r: "ended" | "interrupted") => void) | undefined;
  private startSec = 0;
  private duration = 0;
  private t0 = 0;
  private frozen = 0;

  constructor(private now: () => number = () => performance.now()) {}

  play(pcm: Float32Array, sampleRate: number, startSec: number): Promise<"ended" | "interrupted"> {
    this.stop();
    this.startSec = Math.min(startSec, pcm.length / sampleRate);
    this.duration = pcm.length / sampleRate - this.startSec;
    this.t0 = this.now();
    this.frozen = this.startSec;
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.frozen = this.startSec + this.duration;
        this.resolve = undefined;
        resolve("ended");
      }, this.duration * 1000);
    });
  }

  stop(): void {
    if (this.timer) {
      this.frozen = this.position();
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const r = this.resolve;
    this.resolve = undefined;
    r?.("interrupted");
  }

  position(): number {
    if (!this.timer) return this.frozen;
    return this.startSec + Math.min((this.now() - this.t0) / 1000, this.duration);
  }
}
