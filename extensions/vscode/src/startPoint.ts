// Where to start reading for a cursor on a given line. No vscode imports (unit-testable).
import { segmentAtOffset, type SpeechScript } from "@mdreader/core";

export interface StartPoint {
  index: number;
  /** Word to start at inside the segment; 0 = the segment's beginning. */
  word: number;
}

/**
 * Start from the line the cursor is on:
 * - the first spoken word that begins on that line, in reading order;
 * - from its sentence's beginning when the sentence starts on this line,
 *   otherwise mid-sentence at that word;
 * - lines with no words of their own (blank, inside code/math/diagram blocks)
 *   fall back to the block or sentence containing / following the line.
 */
export function startPointForLine(script: SpeechScript, lineStart: number, lineEnd: number): StartPoint {
  for (const seg of script.segments) {
    if (seg.srcRange[1] <= lineStart) continue;
    if (seg.srcRange[0] >= lineEnd) break;
    const w = seg.words.findIndex((x) => x.srcStart >= lineStart && x.srcStart < lineEnd);
    if (w < 0) continue;
    const startsHere = seg.words[0]!.srcStart >= lineStart;
    return { index: seg.id, word: startsHere ? 0 : w };
  }
  return { index: segmentAtOffset(script, lineStart)?.id ?? 0, word: 0 };
}

/**
 * Start at the word under a source offset (a click in the preview). When several
 * words cover the offset (a table intro spans the whole table, a cell label spans
 * one cell), the most specific one wins. Falls back to the next word after it.
 */
export function startPointAtOffset(script: SpeechScript, offset: number): StartPoint {
  let best: { index: number; word: number; size: number } | undefined;
  for (const seg of script.segments) {
    if (seg.blockRange[1] <= offset || seg.blockRange[0] > offset) continue;
    seg.words.forEach((w, i) => {
      if (w.srcStart <= offset && offset < w.srcEnd) {
        const size = w.srcEnd - w.srcStart;
        if (!best || size < best.size) best = { index: seg.id, word: i, size };
      }
    });
  }
  if (best) return { index: best.index, word: best.word };
  for (const seg of script.segments) {
    const w = seg.words.findIndex((x) => x.srcStart >= offset);
    if (w >= 0) return { index: seg.id, word: w };
  }
  return { index: Math.max(0, script.segments.length - 1), word: 0 };
}
