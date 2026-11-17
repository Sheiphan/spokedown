// Kokoro pads every utterance with ~0.3 s of silence before and ~0.45 s after, which turns each
// full stop into a long gap. Trim that padding (keeping a short natural margin) so the pause
// between sentences is controlled by the reading settings instead.
import type { WordTiming } from "@spokedown/core";

export interface TrimOptions {
  /** Samples quieter than this (absolute, full scale = 1) count as silence. ≈ -48 dBFS. */
  threshold?: number;
  leadKeepMs?: number;
  tailKeepMs?: number;
}

export interface Trimmed {
  pcm: Float32Array;
  words: WordTiming[] | null;
  /** Seconds removed from the start. */
  leadTrimmed: number;
}

export function trimSilence(pcm: Float32Array, sampleRate: number, words: WordTiming[] | null, opts: TrimOptions = {}): Trimmed {
  const threshold = opts.threshold ?? 0.004;
  const leadKeep = Math.round(((opts.leadKeepMs ?? 30) / 1000) * sampleRate);
  const tailKeep = Math.round(((opts.tailKeepMs ?? 60) / 1000) * sampleRate);

  let first = 0;
  while (first < pcm.length && Math.abs(pcm[first]!) < threshold) first++;
  if (first >= pcm.length) return { pcm, words, leadTrimmed: 0 }; // all silence: leave it alone
  let last = pcm.length - 1;
  while (last > first && Math.abs(pcm[last]!) < threshold) last--;

  let start = Math.max(0, first - leadKeep);
  let end = Math.min(pcm.length, last + 1 + tailKeep);
  // Never cut into the first word the model reports. (The last word is not protected: the model's
  // word ends include its trailing silence, and trimming by loudness is what we want there.)
  if (words && words.length) start = Math.min(start, Math.max(0, Math.floor(words[0]!.start * sampleRate) - leadKeep));
  if (start === 0 && end === pcm.length) return { pcm, words, leadTrimmed: 0 };

  const shift = start / sampleRate;
  const length = (end - start) / sampleRate;
  const clamp = (t: number) => Math.min(length, Math.max(0, t - shift));
  return {
    pcm: pcm.slice(start, end),
    words: words ? words.map((w) => ({ ...w, start: clamp(w.start), end: clamp(w.end) })) : null,
    leadTrimmed: shift,
  };
}
