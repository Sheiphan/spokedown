/** A spoken word mapped back to the Markdown source (UTF-16 offsets, end exclusive). */
export interface Word {
  text: string;
  srcStart: number;
  srcEnd: number;
}

export type SegmentKind =
  | "heading"
  | "paragraph"
  | "listItem"
  | "quote"
  | "tableIntro"
  | "tableRow"
  | "code"
  | "data"
  | "diagram"
  | "math"
  | "image"
  | "frontmatter";

/**
 * One unit of speech, usually a sentence. The TTS engine synthesizes one
 * segment at a time; the editor highlights `blockRange` (faint), the
 * segment's `srcRange` (sentence) and the current word.
 */
export interface Segment {
  id: number;
  kind: SegmentKind;
  /** "announce" = a description of the block (e.g. "Python code block, 12 lines") rather than its content. */
  mode: "read" | "announce";
  text: string;
  words: Word[];
  srcRange: [number, number];
  blockRange: [number, number];
  /** Silence to insert before/after this segment, in ms. */
  pauseBefore: number;
  pauseAfter: number;
}

export interface HeadingInfo {
  level: number;
  text: string;
  srcRange: [number, number];
  /** First segment of the heading (index into `segments`). */
  segmentId: number;
}

export interface SpeechScript {
  segments: Segment[];
  headings: HeadingInfo[];
}
