// LaTeX → speech using MathJax (TeX → MathML) + speech-rule-engine (ClearSpeak),
// with pre/post rewrites tuned on real docs (see test/fixtures/real).
import { normalizeText, type NormalizeOptions } from "../normalize.js";
import { numberToWords } from "../numbers.js";

type ToMml = (tex: string, display: boolean) => string;
type Sre = { toSpeech(mml: string): string };

let engine: Promise<{ toMml: ToMml; sre: Sre }> | null = null;

/** Lazily load MathJax + SRE (~100 ms once). */
export function initMath(): Promise<{ toMml: ToMml; sre: Sre }> {
  engine ??= (async () => {
    const [{ mathjax }, { TeX }, { AllPackages }, { liteAdaptor }, { RegisterHTMLHandler }, { SerializedMmlVisitor }, sreMod] =
      await Promise.all([
        import("mathjax-full/js/mathjax.js"),
        import("mathjax-full/js/input/tex.js"),
        import("mathjax-full/js/input/tex/AllPackages.js"),
        import("mathjax-full/js/adaptors/liteAdaptor.js"),
        import("mathjax-full/js/handlers/html.js"),
        import("mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js"),
        import("speech-rule-engine"),
      ]);
    RegisterHTMLHandler(liteAdaptor());
    const doc = mathjax.document("", {
      InputJax: new TeX({ packages: AllPackages.filter((p: string) => p !== "bussproofs") }),
    });
    const visitor = new SerializedMmlVisitor();
    const toMml: ToMml = (tex, display) => visitor.visitTree(doc.convert(tex, { display }));
    const sre = ((sreMod as { default?: unknown }).default ?? sreMod) as Sre & {
      setupEngine(o: object): Promise<void>;
      engineReady(): Promise<void>;
    };
    await sre.setupEngine({ locale: "en", domain: "clearspeak", style: "Fraction_Over", modality: "speech" });
    await sre.engineReady();
    return { toMml, sre };
  })();
  return engine;
}

const MATRIX_RE = /\\begin\{(\w*matrix\*?|array|aligned|cases|smallmatrix)\}(\{[^}]*\})?((?:(?!\\begin\{)[\s\S])*?)\\end\{\1\}/;

function numberWord(n: number): string {
  return numberToWords(String(n), { maxDigits: 4 }, false).join(" ");
}

/** Replace matrices/arrays with a spoken size, innermost first. */
export function replaceMatrices(tex: string): { tex: string; matrices: number } {
  let out = tex;
  let matrices = 0;
  for (let guard = 0; guard < 50; guard++) {
    const m = MATRIX_RE.exec(out);
    if (!m) break;
    const env = m[1]!;
    const rows = m[3]!.split(/\\\\(?:\[[^\]]*\])?/).map((r) => r.trim()).filter((r) => r && !/^\\hline$/.test(r));
    const cols = Math.max(...rows.map((r) => r.replace(/\\hline/g, "").split("&").length), 1);
    let text: string;
    if (env === "cases") text = `cases with ${numberWord(rows.length)} branches`;
    else if (env === "aligned") text = `${numberWord(rows.length)} aligned lines`;
    else text = `a ${numberWord(rows.length)} by ${numberWord(cols)} ${env === "array" ? "table" : "matrix"}`;
    out = out.slice(0, m.index) + `\\text{ ${text} }` + out.slice(m.index + m[0].length);
    matrices++;
  }
  return { tex: out, matrices };
}

export function preprocessTex(tex: string): { tex: string; boxed: boolean; matrices: number } {
  // matrices first: their "\\\\" row separators must not be mistaken for spacing commands
  const r = replaceMatrices(tex);
  let t = r.tex
    .replace(/\\(label|tag)\{[^}]*\}/g, "")
    .replace(/\\(qquad|quad)\b/g, " ")
    .replace(/(?<!\\)\\[;,:!> ]/g, " ")
    .replace(/\\_/g, " ")
    .replace(/\\bmod\b/g, "\\text{ mod }")
    .replace(/\\(t|d)frac/g, "\\frac")
    // index superscripts like q^{(0)}_1 or k'^{(h=0)}: "q sub 1 superscript 0", not "raised to the power"
    .replace(/\^\{\(([^{}()]*)\)\}(?:_(\{[^{}]*\}|\w))?/g, (_m, a: string, sub?: string) =>
      `${sub ? `_${sub}` : ""}\\text{ superscript }{${a}}`);
  const boxed = /\\boxed\b/.test(t);
  t = t.replace(/\\boxed\b/g, "");
  return { tex: t, boxed, matrices: r.matrices };
}

const POST: [RegExp, string][] = [
  [/raised to the (?:exponent )?normal down tack(?: power| end exponent)/g, "transpose"],
  [/raised to the exponent (.+?) end exponent/g, "raised to the $1 power"],
  [/normal down tack/g, "transpose"],
  [/normal infinity/g, "infinity"],
  [/\bnormal\s+/g, ""],
  [/\btilde\b/g, "about"],
  [/\s*\bperiod$/g, ""],
  [/\bl n\b/g, "log"],
  [/\bdot dot dot\b/g, "through"],
  [/\ben dash\b/g, "to"],
  [/\bend of proof\b/g, ""],
  [/\bthe metric of\b/g, "the norm of"],
  [/\bmetric\b/g, "norm"],
  [/\benclosed with box\b/g, ""],
  [/ over bottom brace over (monospace )?/g, ", that is, "],
  [/ under top brace under (monospace )?/g, ", that is, "],
  [/\bmonospace\b/g, ""],
  [/\bof slash\b/g, "over"],
  [/\bslash\b/g, "over"],
  [/\bleft arrow\b/g, "becomes"],
  [/\bright arrow\b/g, "to"],
  [/\b([A-Za-z]{3,}) times open paren\b/g, "$1 of open paren"],
  [/\bopen (paren|bracket|brace)\s*/g, ""],
  [/\s*\bclose (paren|bracket|brace)\b/g, ","],
  [/\bleft floor\b/g, "the floor of"],
  [/\bright floor\b/g, ","],
  [/\bleft ceiling\b/g, "the ceiling of"],
  [/\bright ceiling\b/g, ","],
  [/\bdivision sign\b/g, "divided by"],
  [/\bscript l\b/g, "l"],
  [/\s*\bcomma\b/g, ","],
  [/\bsemicolon\b/g, ","],
  [/\s+,/g, ","],
  [/,(\s*,)+/g, ","],
  [/,\s*$/g, ""],
  [/\s{2,}/g, " "],
];

export function postprocessSpeech(s: string): string {
  let out = s;
  for (const [re, rep] of POST) out = out.replace(re, rep);
  return out.trim();
}

export interface MathSpeech {
  words: string[];
  /** true when the expression could not be parsed and a fallback was used */
  failed: boolean;
  matrices: number;
}

/** Requires `await initMath()` first. */
export async function texToWords(tex: string, display: boolean, opts: NormalizeOptions): Promise<MathSpeech> {
  const { toMml, sre } = await initMath();
  const pre = preprocessTex(tex);
  const fallback = { words: display ? ["an", "equation"] : ["a", "formula"], failed: true, matrices: pre.matrices };
  let speech: string;
  try {
    const mml = toMml(pre.tex, display);
    if (mml.includes("<merror")) return fallback; // MathJax reports TeX errors in the tree instead of throwing
    speech = postprocessSpeech(sre.toSpeech(mml));
  } catch {
    return fallback;
  }
  if (!speech) return fallback;
  const words = normalizeText(speech, opts);
  if (pre.boxed) words.unshift("final", "result,");
  return { words, failed: false, matrices: pre.matrices };
}
