// Keep a speech script's source offsets valid while the user edits the document.
import type { SpeechScript } from "@mdreader/core";

export interface TextChange {
  /** Offset in the document before this batch of changes. */
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/** Map an offset through a batch of non-overlapping changes (all relative to the old text). */
export function shiftOffset(off: number, changes: readonly TextChange[]): number {
  let delta = 0;
  for (const c of changes) {
    const start = c.rangeOffset;
    const end = start + c.rangeLength;
    if (off >= end) delta += c.text.length - c.rangeLength;
    else if (off > start) return start + delta + Math.min(off - start, c.text.length); // inside a replaced range
  }
  return off + delta;
}

/** Shift every offset in the script in place. */
export function shiftScript(script: SpeechScript, changes: readonly TextChange[]): void {
  if (!changes.length) return;
  const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
  const f = (o: number) => shiftOffset(o, sorted);
  for (const s of script.segments) {
    s.srcRange = [f(s.srcRange[0]), f(s.srcRange[1])];
    s.blockRange = [f(s.blockRange[0]), f(s.blockRange[1])];
    for (const w of s.words) {
      w.srcStart = f(w.srcStart);
      w.srcEnd = f(w.srcEnd);
    }
  }
  for (const h of script.headings) h.srcRange = [f(h.srcRange[0]), f(h.srcRange[1])];
}
