// Word timing: map engine timings (or estimates) onto a segment's spoken words.
import type { Word } from "./types.js";

export interface WordTiming {
  /** seconds from the start of the segment's audio */
  start: number;
  end: number;
  /** The engine's own token for this word (e.g. Kokoro phonemes), used for robust alignment. */
  ph?: string;
}

export type TimingQuality = "native" | "estimated";

/** Rough spoken length of a written word (≈ phoneme count). */
function expectedLength(text: string): number {
  const letters = text.replace(/[^\p{L}\p{N}']/gu, "");
  if (letters.length === 1) return 3; // a spelled letter: "Q" → kjuː
  if (/^[A-Z]{2,3}$/.test(letters)) return letters.length * 2.5; // acronym spelled out
  return Math.max(letters.length * 0.85, 1);
}

function phLength(ph: string): number {
  return ph.replace(/[ˈˌː.,;:!?"'()\-—]/g, "").length || 1;
}

const relCost = (a: number, b: number) => Math.abs(a - b) / (a + b + 1);

/** Distribute [from, to] over words in proportion to their spoken length. */
export function estimateTimings(ws: Pick<Word, "text">[], from: number, to: number): WordTiming[] {
  const weights = ws.map((w) => expectedLength(w.text) + 1.5 + (/[,;:]$/.test(w.text) ? 3 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const span = Math.max(to - from, 0);
  let t = from;
  return weights.map((wt) => {
    const d = (span * wt) / total;
    const timing = { start: t, end: t + d };
    t += d;
    return timing;
  });
}

/**
 * Align text words to engine words when counts differ (the phonemizer merges
 * "on the" → "ɔnðə" or splits a word). Dynamic programming over 1:1, 2:1, 1:2,
 * 3:1 and skip moves, scored by how well phoneme length matches word length.
 */
export function alignByLength(ws: Pick<Word, "text">[], eng: WordTiming[]): WordTiming[] | null {
  const n = ws.length;
  const m = eng.length;
  if (!n || !m || !eng.every((e) => e.ph !== undefined)) return null;
  const est = ws.map((w) => expectedLength(w.text));
  const pl = eng.map((e) => phLength(e.ph!));
  const INF = Number.POSITIVE_INFINITY;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(INF));
  const move: [number, number][][] = Array.from({ length: n + 1 }, () => new Array<[number, number]>(m + 1));
  cost[0]![0] = 0;
  // [text words consumed, engine words consumed, penalty]
  const moves: [number, number, number][] = [[1, 1, 0], [2, 1, 0.35], [3, 1, 0.7], [1, 2, 0.35], [1, 0, 1.5], [0, 1, 1.5]];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = cost[i]![j]!;
      if (c === INF) continue;
      for (const [di, dj, pen] of moves) {
        const ni = i + di;
        const nj = j + dj;
        if (ni > n || nj > m) continue;
        let a = 0;
        let b = 0;
        for (let k = i; k < ni; k++) a += est[k]!;
        for (let k = j; k < nj; k++) b += pl[k]!;
        const nc = c + pen + (di && dj ? relCost(a, b) : 0);
        if (nc < cost[ni]![nj]!) {
          cost[ni]![nj] = nc;
          move[ni]![nj] = [di, dj];
        }
      }
    }
  }
  if (cost[n]![m] === INF) return null;

  // Backtrack into groups, then assign times.
  const groups: { i: number; di: number; j: number; dj: number }[] = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const [di, dj] = move[i]![j]!;
    groups.unshift({ i: i - di, di, j: j - dj, dj });
    i -= di;
    j -= dj;
  }
  const out: WordTiming[] = new Array(n);
  let lastEnd = eng[0]!.start;
  for (const g of groups) {
    if (g.di === 0) continue; // extra engine word: its time is absorbed by neighbours
    const start = g.dj ? eng[g.j]!.start : lastEnd;
    const end = g.dj ? eng[g.j + g.dj - 1]!.end : lastEnd;
    if (g.di === 1) out[g.i] = { start, end };
    else {
      // several text words spoken as one engine word: split by expected length
      const parts = estimateTimings(ws.slice(g.i, g.i + g.di), start, end);
      parts.forEach((p, k) => (out[g.i + k] = p));
    }
    lastEnd = end;
  }
  return out;
}

/**
 * Align engine word timings to the segment's words: 1:1 when counts match,
 * length-based DP when the engine merged/split words, otherwise an estimate
 * across the engine's spoken span (or the whole audio).
 */
export function alignWordTimings(
  ws: Pick<Word, "text">[],
  engineWords: WordTiming[] | null | undefined,
  audioDuration: number,
): { timings: WordTiming[]; quality: TimingQuality } {
  const strip = (t: WordTiming[]) => t.map(({ start, end }) => ({ start, end }));
  if (engineWords && engineWords.length === ws.length) return { timings: strip(engineWords), quality: "native" };
  if (engineWords?.length) {
    const aligned = alignByLength(ws, engineWords);
    if (aligned) return { timings: aligned, quality: "native" };
  }
  const from = engineWords?.[0]?.start ?? 0;
  const to = engineWords?.[engineWords.length - 1]?.end ?? audioDuration;
  return { timings: estimateTimings(ws, from, to), quality: "estimated" };
}

/** Index of the word being spoken at time t (seconds), or -1 before the first word. */
export function wordIndexAt(timings: WordTiming[], t: number): number {
  let lo = 0;
  let hi = timings.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timings[mid]!.start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
