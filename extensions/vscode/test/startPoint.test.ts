import { describe, expect, it } from "vitest";
import { buildSpeechScript } from "@mdreader/core";
import { startPointForLine } from "../src/startPoint.js";

const DOC = [
  "# Title", //                                  0
  "", //                                         1
  "First sentence on one line. Second sentence", // 2
  "wraps onto this line and ends here.", //      3
  "", //                                         4
  "```python", //                                5
  "x = 1", //                                    6
  "```", //                                      7
  "", //                                         8
  "| a | b |", //                                9
  "|---|---|", //                                10
  "| 1 | 2 |", //                                11
  "", //                                         12
  "Last line.", //                               13
].join("\n");

const lines = DOC.split("\n");
const lineRange = (n: number): [number, number] => {
  const start = lines.slice(0, n).reduce((a, l) => a + l.length + 1, 0);
  return [start, start + lines[n]!.length + 1];
};

describe("startPointForLine", async () => {
  const script = await buildSpeechScript(DOC);
  const at = (n: number) => {
    const sp = startPointForLine(script, ...lineRange(n));
    const seg = script.segments[sp.index]!;
    return { text: seg.text, word: seg.words[sp.word]!.text, mid: sp.word > 0 };
  };

  it("starts a sentence that begins on the cursor line from its beginning", () => {
    expect(at(2)).toEqual({ text: "First sentence on one line.", word: "First", mid: false });
  });

  it("starts mid-sentence at the first word of a continuation line", () => {
    expect(at(3)).toEqual({ text: "Second sentence wraps onto this line and ends here.", word: "wraps", mid: true });
  });

  it("starts a heading line at the heading", () => {
    expect(at(0).text).toBe("Title.");
  });

  it("starts at the code block announcement from inside the block", () => {
    expect(at(6).text).toBe("Python code block, one line.");
  });

  it("starts at the table row the cursor is on", () => {
    expect(at(11).text).toBe("Row one: a: one, b: two.");
  });

  it("starts at the next sentence from a blank line", () => {
    expect(at(12).text).toBe("Last line.");
  });
});
