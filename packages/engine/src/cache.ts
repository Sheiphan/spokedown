// On-disk audio cache: re-reading a document (or seeking back) is instant.
// One file per entry: [u32 metaLen][meta JSON][Int16 PCM]. Oldest entries are evicted past maxBytes.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SynthesisResult } from "./types.js";

/** Bump when synthesis output for the same inputs changes (e.g. timing extraction fixes). */
export const CACHE_VERSION = 3;

export function cacheKey(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ v: CACHE_VERSION, ...parts })).digest("hex").slice(0, 40);
}

export class AudioCache {
  private totalBytes: number | null = null;

  constructor(private dir: string, private maxBytes = 512 * 1024 * 1024) {}

  private file(key: string): string {
    return path.join(this.dir, `${key}.pcm`);
  }

  async get(key: string): Promise<SynthesisResult | null> {
    try {
      const buf = await fs.readFile(this.file(key));
      const metaLen = buf.readUInt32LE(0);
      const meta = JSON.parse(buf.subarray(4, 4 + metaLen).toString("utf8")) as Omit<SynthesisResult, "pcm">;
      const start = 4 + metaLen;
      const n = (buf.length - start) >> 1;
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(start + i * 2) / 32767;
      const now = new Date();
      fs.utimes(this.file(key), now, now).catch(() => undefined); // LRU touch
      return { ...meta, pcm };
    } catch {
      return null;
    }
  }

  async put(key: string, r: SynthesisResult): Promise<void> {
    const meta = Buffer.from(JSON.stringify({ sampleRate: r.sampleRate, words: r.words }), "utf8");
    const buf = Buffer.alloc(4 + meta.length + r.pcm.length * 2);
    buf.writeUInt32LE(meta.length, 0);
    meta.copy(buf, 4);
    const start = 4 + meta.length;
    for (let i = 0; i < r.pcm.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r.pcm[i]!)) * 32767), start + i * 2);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(key)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, this.file(key));
    if (this.totalBytes !== null) this.totalBytes += buf.length;
    await this.prune();
  }

  async sizeBytes(): Promise<number> {
    const entries = await this.entries();
    this.totalBytes = entries.reduce((n, e) => n + e.size, 0);
    return this.totalBytes;
  }

  async clear(): Promise<void> {
    for (const e of await this.entries()) await fs.rm(e.file, { force: true });
    this.totalBytes = 0;
  }

  private async entries(): Promise<{ file: string; size: number; mtime: number }[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names.filter((x) => x.endsWith(".pcm"))) {
      const file = path.join(this.dir, n);
      try {
        const st = await fs.stat(file);
        out.push({ file, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* removed concurrently */
      }
    }
    return out;
  }

  private async prune(): Promise<void> {
    if (this.totalBytes === null) await this.sizeBytes();
    if (this.totalBytes! <= this.maxBytes) return;
    const entries = (await this.entries()).sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((n, e) => n + e.size, 0);
    for (const e of entries) {
      if (total <= this.maxBytes * 0.9) break;
      await fs.rm(e.file, { force: true });
      total -= e.size;
    }
    this.totalBytes = total;
  }
}
