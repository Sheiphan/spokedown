import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSpeechScript, segmentAtOffset, type SpeechScript } from "../src/index.js";

const fixture = (p: string) => fs.readFileSync(path.join(__dirname, "fixtures", p), "utf8");
const texts = (s: SpeechScript) => s.segments.map((x) => x.text);

/** Invariants every script must satisfy, whatever the input. */
function checkInvariants(src: string, script: SpeechScript, maxChars = 350): void {
  let prevStart = -1;
  for (const seg of script.segments) {
    expect(seg.words.length).toBeGreaterThan(0);
    expect(seg.text).toBe(seg.words.map((w) => w.text).join(" "));
    expect(seg.text.length).toBeLessThanOrEqual(maxChars + 40); // a single long word may overflow slightly
    expect(seg.srcRange[0]).toBeGreaterThanOrEqual(prevStart);
    prevStart = seg.srcRange[0];
    let prevWord = -1;
    // a table intro interleaves "N rows" (whole table) with header labels (header cells)
    const ordered = seg.kind !== "tableIntro";
    for (const w of seg.words) {
      expect(w.text.trim()).toBe(w.text);
      expect(w.text).not.toBe("");
      expect(w.srcStart).toBeGreaterThanOrEqual(0);
      expect(w.srcEnd).toBeLessThanOrEqual(src.length);
      expect(w.srcStart).toBeLessThan(w.srcEnd);
      if (ordered) expect(w.srcStart).toBeGreaterThanOrEqual(prevWord);
      prevWord = w.srcStart;
      expect(w.srcStart).toBeGreaterThanOrEqual(seg.blockRange[0]);
      expect(w.srcEnd).toBeLessThanOrEqual(seg.blockRange[1]);
    }
    // no leaked markup or TeX
    expect(seg.text).not.toMatch(/[\\{}$|`#*<>]|\b(begin|frac|mathrm|operatorname)\b/);
  }
}

describe("kitchen sink", async () => {
  const src = fixture("synthetic/kitchen-sink.md");
  const script = await buildSpeechScript(src, { fileName: "kitchen-sink.md" });
  const all = texts(script).join("\n");

  it("satisfies invariants", () => checkInvariants(src, script));

  it("skips frontmatter, html and footnote definitions by default", () => {
    expect(all).not.toMatch(/Kitchen sink\b(?! for)|tags|html comment|Hidden|raw html|footnote text/);
  });

  it("reads headings with pauses and records them", () => {
    expect(script.segments[0]!.text).toBe("Kitchen sink for the reader.");
    expect(script.segments[0]!.kind).toBe("heading");
    expect(script.headings.map((h) => h.text)).toEqual(["Kitchen sink for the reader.", "Lists.", "Table.", "Code."]);
    expect(script.headings[1]!.level).toBe(2);
  });

  it("normalizes inline content", () => {
    expect(all).toContain("inline code, a link and a bare URL link to github dot com.");
    expect(all).toContain("It costs about five percent more, sometimes.");
    expect(all).toContain("See section two and claude dot M D for details, or not.");
  });

  it("reads lists with numbers, nesting and task state", () => {
    expect(all).toContain("one, First ordered item");
    expect(all).toContain("two, Second item with x squared inside");
    expect(all).toContain("nested bullet one");
    expect(all).toContain("done, finished task");
    expect(all).toContain("to do, open task");
  });

  it("announces alerts", () => {
    const i = texts(script).indexOf("Warning.");
    expect(i).toBeGreaterThan(-1);
    expect(script.segments[i]!.mode).toBe("announce");
    expect(script.segments[i + 1]!.text).toBe("Do not run this in production.");
  });

  it("adds a pause for thematic breaks", () => {
    const seg = script.segments.find((s) => s.text === "Table.")!;
    expect(seg.pauseBefore).toBeGreaterThanOrEqual(700);
  });

  it("introduces tables and reads rows with labels", () => {
    expect(all).toContain("Table, three columns: Name, Value, Note, two rows.");
    expect(all).toContain("Row one: Name: alpha, Value: about one, Note: first.");
    expect(all).toContain("Row two: Name: beta, Value: empty, Note: beta v two.");
    const intro = script.segments.find((s) => s.kind === "tableIntro")!;
    expect(intro.mode).toBe("announce");
  });

  it("announces code, data and diagrams as blocks", () => {
    const by = (k: string) => script.segments.filter((s) => s.kind === k).map((s) => s.text);
    expect(by("code")).toEqual(["Python code block, two lines."]);
    expect(by("data")).toEqual(["Data block, two lines."]);
    expect(by("diagram")).toEqual(["Diagram: flowchart with three steps."]);
    for (const k of ["code", "data", "diagram"]) {
      const seg = script.segments.find((s) => s.kind === k)!;
      expect(seg.mode).toBe("announce");
      expect(seg.words.every((w) => w.srcStart === seg.blockRange[0] && w.srcEnd === seg.blockRange[1])).toBe(true);
    }
  });

  it("reads short display math", () => {
    expect(script.segments.find((s) => s.kind === "math")!.text).toBe("a over b equals the square root of c.");
  });

  it("reads image alt text", () => {
    expect(script.segments.find((s) => s.kind === "image")!.text).toBe("image: a cat on a mat");
  });

  it("maps plain-text words to their exact source token", () => {
    const seg = script.segments.find((s) => s.text.startsWith("A paragraph with"))!;
    for (const w of seg.words.slice(0, 3)) {
      expect(src.slice(w.srcStart, w.srcEnd).toLowerCase().replace(/[^a-z]/g, "")).toBe(w.text.toLowerCase().replace(/[^a-z]/g, ""));
    }
  });

  it("finds the segment for a cursor offset", () => {
    const off = src.indexOf("| beta");
    const seg = segmentAtOffset(script, off)!;
    expect(seg.text.startsWith("Row two")).toBe(true);
  });
});

describe("options", () => {
  const src = fixture("synthetic/kitchen-sink.md");
  it("can skip code, tables and diagrams", async () => {
    const s = await buildSpeechScript(src, { code: "skip", tables: "skip", mermaid: "skip", dataBlocks: "skip" });
    expect(s.segments.some((x) => ["code", "tableIntro", "tableRow", "diagram", "data"].includes(x.kind))).toBe(false);
  });
  it("can read code line by line, mapped to lines", async () => {
    const s = await buildSpeechScript(src, { code: "read" });
    const lines = s.segments.filter((x) => x.kind === "code" && x.mode === "read");
    expect(lines.map((l) => l.text)).toEqual(["def f x.", "return x power two."]);
    expect(src.slice(lines[1]!.words[0]!.srcStart, lines[1]!.words[0]!.srcEnd)).toBe("    return x ** 2");
  });
  it("announces display math when asked", async () => {
    const s = await buildSpeechScript(src, { mathDisplay: "announce" });
    expect(s.segments.find((x) => x.kind === "math")!.text).toBe("Equation.");
  });
  it("splits long sentences under the chunk limit", async () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i},`).join(" ") + " end.";
    const s = await buildSpeechScript(long, { maxSegmentChars: 120 });
    expect(s.segments.length).toBeGreaterThan(3);
    for (const seg of s.segments) expect(seg.text.length).toBeLessThanOrEqual(120);
  });
});

describe("SKILL.md", () => {
  it("announces the skill name and description from frontmatter", async () => {
    const s = await buildSpeechScript(fixture("synthetic/SKILL.md"), { fileName: "skills/pdf/SKILL.md" });
    expect(s.segments.slice(0, 2).map((x) => x.text)).toEqual(["Skill: pdf reader.", "Read PDF files aloud with word highlighting."]);
    expect(s.segments[0]!.mode).toBe("announce");
  });
});

describe("real docs", () => {
  for (const name of fs.readdirSync(path.join(__dirname, "fixtures/docs"))) {
    it(`${name}: invariants + golden script`, async () => {
      const src = fixture(`docs/${name}`);
      const script = await buildSpeechScript(src, { fileName: name });
      checkInvariants(src, script);
      const lineOf = (off: number) => src.slice(0, off).split("\n").length;
      const golden = script.segments
        .map((s) => `L${lineOf(s.srcRange[0])} ${s.kind}${s.mode === "announce" ? " »" : ""}: ${s.text}`)
        .join("\n");
      await expect(golden + "\n").toMatchFileSnapshot(`golden/${name.replace(/\.md$/, ".txt")}`);
    }, 30_000);
  }
});
