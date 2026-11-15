import { describe, expect, it } from "vitest";
import { numberToWords } from "../src/numbers.js";
import { normalizeText, normalizeToken, splitIdentifier } from "../src/normalize.js";
import { codeToSpeech, describeCodeBlock, isDataBlock } from "../src/rules/code.js";
import { countFlowchartNodes, describeMermaid } from "../src/rules/mermaid.js";
import { preprocessTex, texToWords } from "../src/rules/math.js";
import { normalizeDisplayMath, displayMathTex } from "../src/parse.js";
import { alignWordTimings, estimateTimings, wordIndexAt } from "../src/align.js";
import { DEFAULT_OPTIONS } from "../src/options.js";

const o = DEFAULT_OPTIONS;
const say = (s: string) => normalizeText(s, o).join(" ");

describe("numbers", () => {
  it.each([
    ["0", "zero"],
    ["7", "seven"],
    ["42", "forty-two"],
    ["1,024", "one thousand twenty-four"],
    ["10000", "ten thousand"],
    ["2017", "twenty seventeen"],
    ["2005", "two thousand five"],
    ["1900", "nineteen hundred"],
    ["-0.5", "minus zero point five"],
    ["6.25", "six point two five"],
    ["0.99999952", "about one"],
    ["1.41421318", "about one point four one four"],
    ["0.00000000", "zero"],
    ["12%", "twelve percent"],
    ["022", "zero two two"],
  ])("%s → %s", (n, words) => {
    expect(numberToWords(n, o).join(" ")).toBe(words);
  });
});

describe("normalize", () => {
  it.each([
    ["see §2 now", "see section two now"],
    ["e.g. this", "for example this"],
    ["rows ↔ columns", "rows both ways columns"],
    ["a → b", "a to b"],
    ["x ≈ 3", "x approximately three"],
    ["Cauchy–Schwarz inequality", "Cauchy-Schwarz inequality"],
    ["cols 3–7", "cols three to seven"],
    ["CLAUDE.md", "claude dot M D"],
    ["https://github.com/foo/bar", "link to github dot com"],
    ["a (b c) d", "a, b c, d"],
    ["a — b", "a, b"],
    ["done ✓", "done"],
    ["🎉 party", "party"],
    ["22B params", "twenty-two billion params"],
  ])("%s → %s", (input, out) => {
    expect(say(input)).toBe(out);
  });

  it("splits identifiers", () => {
    expect(splitIdentifier("forward_with_trace")).toEqual(["forward", "with", "trace"]);
    expect(splitIdentifier("RMSNorm")).toEqual(["R", "M", "S", "Norm"]);
    expect(splitIdentifier("qk_norm")).toEqual(["Q", "K", "norm"]);
  });

  it("keeps a possessive as one glued token", () => {
    expect(normalizeToken("'s", o)).toEqual(["'s"]);
  });
});

describe("code", () => {
  it.each([
    ["attention.py:183", "attention dot P Y, line one hundred eighty-three"],
    ["config.py:114-117", "config dot P Y, lines one hundred fourteen to one hundred seventeen"],
    ["(1, 3, 8)", "shape one, three, eight"],
    ["self.qk_norm=True", "self dot Q K norm equals True"],
    ["uv run python scripts/check_001_softmax.py", "uv run python check zero zero one softmax dot P Y"],
    ["x * rsqrt(v)", "x times rsqrt v"],
  ])("%s → %s", (code, out) => {
    expect(codeToSpeech(code, o).join(" ")).toBe(out);
  });

  it("detects numeric dumps as data blocks", () => {
    expect(isDataBlock(null, "[[1.000000, 0.000000],\n [0.568624, 0.431376]]")).toBe(true);
    expect(isDataBlock(null, "q_pre_norm  head 0: [[1,1,1,1],  [3,0,4,0]]")).toBe(true);
    expect(isDataBlock("python", "[[1, 2]]")).toBe(false);
    expect(isDataBlock(null, "Usage: run the thing\nthen do the other")).toBe(false);
  });

  it("describes code blocks", () => {
    expect(describeCodeBlock("python", "a\nb\nc\n", o).words.join(" ")).toBe("Python code block, three lines.");
    expect(describeCodeBlock(null, "echo hi", o).words.join(" ")).toBe("Code block, one line.");
  });
});

describe("mermaid", () => {
  const qk = `flowchart TB
    X["x  (1, 3, 4) -- input
    (one row per token)"]
    X --> P["Step 1: project"]
    P --> D{"causal?"}
    D -->|"yes (default)"| MASK["add mask"]
    D -->|"no"| RAW["scores unchanged"]
    RAW --> SM
    MASK --> SM["Step 3: softmax"]
    SM --> G["Step 4: weights"]
    G --> SC["Step 5: probs . v"]
    SC --> MK["Step 6: concat"]
    MK --> OUT["Step 7: project out"]
    OUT --> WS["Step 8: residual"]
    WS --> O["output"]`;
  it("counts flowchart nodes, ignoring multi-line labels", () => {
    expect(countFlowchartNodes(qk)).toBe(12);
  });
  it("describes types", () => {
    expect(describeMermaid(qk, o).join(" ")).toBe("Diagram: flowchart with twelve steps.");
    expect(describeMermaid("sequenceDiagram\n  A->>B: hi\n  B-->>A: yo", o).join(" ")).toBe("Diagram: sequence diagram with two participants.");
    expect(describeMermaid("pie title X\n  \"a\": 1", o).join(" ")).toBe("Diagram: pie chart.");
  });
});

describe("math", () => {
  it("replaces matrices with their size, keeping row separators intact", () => {
    const { tex } = preprocessTex(String.raw`X = \begin{bmatrix} x_0 \\ x_1 \\ x_2 \end{bmatrix} = \begin{bmatrix} 1 & 0 \\ 0 & 1 \\ 2 & 2 \end{bmatrix}`);
    expect(tex).toContain("a three by one matrix");
    expect(tex).toContain("a three by two matrix");
  });

  it.each([
    [String.raw`\sqrt{d_k}`, "the square root of d sub k"],
    [String.raw`QK^{\top}`, "Q K transpose"],
    [String.raw`\lVert a\rVert`, "the norm of a"],
    [String.raw`3\times10^{-8}`, "three times ten to the negative eight power"],
    [String.raw`q^{(0)}_1`, "q sub one superscript zero"],
    [String.raw`\operatorname{softmax}(z)`, "softmax of z"],
    [String.raw`H \bmod H_{kv} = 0`, "H mod H sub k v equals zero"],
  ])("%s → %s", async (tex, out) => {
    expect((await texToWords(tex, false, o)).words.join(" ")).toBe(out);
  });

  it("never throws on bad TeX", async () => {
    const r = await texToWords(String.raw`\frac{a}{`, true, o);
    expect(r.failed).toBe(true);
    expect(r.words.join(" ")).toBe("an equation");
  });
});

describe("display math pre-pass", () => {
  it("rewrites content-bearing $$ lines without changing length", () => {
    const src = "Intro\n\n$$X = \\begin{bmatrix} 1 \\\\ 2\n\\end{bmatrix}$$\n\nAfter $y$\n\n```\n$$ not math\n```\n";
    const out = normalizeDisplayMath(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").map((l) => l.length)).toEqual(src.split("\n").map((l) => l.length));
    expect(out.split("\n")[2]!.trim()).toBe("$$");
    expect(out.split("\n")[3]!.trim()).toBe("$$");
    expect(out).toContain("$$ not math"); // code fence untouched
  });
  it("extracts TeX from the original source", () => {
    const src = "$$X = 1\n+ 2$$";
    expect(displayMathTex(src, 0, src.length)).toBe("X = 1\n+ 2");
  });
});

describe("align", () => {
  const ws = [{ text: "hello," }, { text: "big" }, { text: "world." }];
  it("uses engine timings when counts match", () => {
    const eng = [{ start: 0, end: 0.4 }, { start: 0.5, end: 0.7 }, { start: 0.8, end: 1.2 }];
    expect(alignWordTimings(ws, eng, 1.3)).toEqual({ timings: eng, quality: "native" });
  });
  it("estimates when counts differ, inside the engine's span", () => {
    const r = alignWordTimings(ws, [{ start: 0.2, end: 0.5 }, { start: 0.6, end: 1.0 }], 1.3);
    expect(r.quality).toBe("estimated");
    expect(r.timings[0]!.start).toBeCloseTo(0.2);
    expect(r.timings[2]!.end).toBeCloseTo(1.0);
  });
  it("aligns when the phonemizer merges two words into one", () => {
    const text = ["slows", "down", "on", "the", "parts", "QK-norm"].map((t) => ({ text: t }));
    const eng = [
      { start: 0.0, end: 0.4, ph: "slˈoʊz" },
      { start: 0.4, end: 0.8, ph: "dˌaʊn" },
      { start: 0.8, end: 1.0, ph: "ɔnðə" }, // "on the"
      { start: 1.0, end: 1.4, ph: "pˈɑːɹts" },
      { start: 1.4, end: 2.2, ph: "kjˌuːkˈeɪnˈɔːɹm" },
    ];
    const r = alignWordTimings(text, eng, 2.3);
    expect(r.quality).toBe("native");
    expect(r.timings.map((t) => +t.start.toFixed(2))).toEqual([0, 0.4, 0.8, expect.any(Number), 1.0, 1.4]);
    expect(r.timings[3]!.start).toBeGreaterThan(0.8);
    expect(r.timings[3]!.end).toBeCloseTo(1.0);
  });
  it("finds the current word", () => {
    const t = estimateTimings(ws, 0, 3);
    expect(wordIndexAt(t, -1)).toBe(-1);
    expect(wordIndexAt(t, 0)).toBe(0);
    expect(wordIndexAt(t, 2.99)).toBe(2);
  });
});
