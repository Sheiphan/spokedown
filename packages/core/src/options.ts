import type { NormalizeOptions } from "./normalize.js";

export interface ReaderOptions extends NormalizeOptions {
  /** Used for file-specific behaviour, e.g. SKILL.md frontmatter. */
  fileName?: string;
  code: "announce" | "read" | "skip";
  /** In "read" mode, read at most this many lines, then say how many remain. */
  codeReadMaxLines: number;
  dataBlocks: "announce" | "skip";
  mermaid: "announce" | "skip";
  tables: "rows" | "announce" | "skip";
  mathInline: "read" | "announce";
  /** announce: "Equation." · short: read if ≤ mathShortMaxWords, else announce · full: always read */
  mathDisplay: "announce" | "short" | "full";
  mathShortMaxWords: number;
  /** Inline math longer than this is replaced by "a formula". */
  mathInlineMaxWords: number;
  frontmatter: "skip" | "announce";
  footnotes: "skip" | "read";
  images: "alt" | "skip";
  /** Long sentences are split near this many characters (Kokoro limit ≈ 510 phonemes). */
  maxSegmentChars: number;
  pauses: {
    heading: number;
    afterHeading: number;
    paragraph: number;
    block: number;
    thematicBreak: number;
  };
}

export const DEFAULT_OPTIONS: ReaderOptions = {
  maxDigits: 4,
  readCheckmarks: false,
  code: "announce",
  codeReadMaxLines: 20,
  dataBlocks: "announce",
  mermaid: "announce",
  tables: "rows",
  mathInline: "read",
  mathDisplay: "short",
  mathShortMaxWords: 40,
  mathInlineMaxWords: 60,
  frontmatter: "skip",
  footnotes: "skip",
  images: "alt",
  maxSegmentChars: 350,
  pauses: { heading: 700, afterHeading: 350, paragraph: 300, block: 450, thematicBreak: 700 },
};

export type ReaderOptionsInput = Partial<Omit<ReaderOptions, "pauses">> & { pauses?: Partial<ReaderOptions["pauses"]> };

export function resolveOptions(input: ReaderOptionsInput = {}): ReaderOptions {
  return { ...DEFAULT_OPTIONS, ...input, pauses: { ...DEFAULT_OPTIONS.pauses, ...input.pauses } };
}
