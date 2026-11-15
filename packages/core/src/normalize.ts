// Plain-text normalization: one source token (a whitespace-free run) → spoken words.
import { isNumberToken, numberToWords, type NumberOptions } from "./numbers.js";

export interface NormalizeOptions extends NumberOptions {
  /** Speak ✓/✗ marks ("check", "cross") instead of skipping them. */
  readCheckmarks: boolean;
}

const GREEK: Record<string, string> = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ζ: "zeta", η: "eta", θ: "theta",
  ι: "iota", κ: "kappa", λ: "lambda", μ: "mu", ν: "nu", ξ: "xi", π: "pi", ρ: "rho", σ: "sigma",
  τ: "tau", υ: "upsilon", φ: "phi", χ: "chi", ψ: "psi", ω: "omega", Δ: "delta", Σ: "sigma",
  Π: "pi", Ω: "omega", Θ: "theta", Λ: "lambda", Φ: "phi", Ψ: "psi", Γ: "gamma",
};

// Symbols replaced inside a token (surrounded by spaces so they split it).
const SYMBOLS: Record<string, string> = {
  "→": " to ", "⟶": " to ", "⇒": " implies ", "⟹": " implies ", "↔": " both ways ", "⇔": " if and only if ",
  "←": " ", "⟵": " ", "↑": " up ", "↓": " down ",
  "≈": " approximately ", "≃": " approximately ", "≅": " approximately ", "∼": " about ",
  "≤": " less than or equal to ", "≥": " greater than or equal to ", "≠": " not equal to ",
  "≪": " much less than ", "≫": " much greater than ", "≡": " is equivalent to ",
  "±": " plus or minus ", "×": " times ", "÷": " divided by ", "∙": " ",
  "∞": " infinity ", "√": " square root of ", "∑": " sum of ", "∏": " product of ",
  "∂": " partial ", "∇": " gradient ", "∈": " in ", "∉": " not in ", "∀": " for all ", "∃": " there exists ",
  "²": " squared ", "³": " cubed ", "°": " degrees ", "′": " prime ",
  "§§": " sections ", "§": " section ", "¶": " paragraph ",
  "&": " and ", "+": " plus ", "=": " equals ", "<": " less than ", ">": " greater than ",
  "|": " ", "*": " ", "_": " ", "`": " ", "#": " number ", "^": " ", "\\": " ", "/": " ",
  "∎": " ", "□": " ", "■": " ",
  "…": "...", "—": " , ", "―": " , ", "·": " , ", "•": " , ",
};
const CHECKS = ["✓", "✔", "✅", "☑", "✗", "✘", "❌"];

const ABBREVIATIONS: Record<string, string> = {
  "e.g.": "for example", "e.g.,": "for example,", "i.e.": "that is", "i.e.,": "that is,",
  "vs.": "versus", "vs": "versus", "etc.": "etcetera.", "etc": "etcetera", "approx.": "approximately",
  "fig.": "figure", "eq.": "equation", "eqs.": "equations", "al.": "al.", "w.r.t.": "with respect to",
  "cf.": "compare", "resp.": "respectively",
};

const FILE_EXT: Record<string, string> = {
  md: "M D", mdx: "M D X", py: "P Y", ts: "T S", tsx: "T S X", js: "J S", mjs: "M J S", cjs: "C J S",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "toml", txt: "text", sh: "S H", rs: "R S", go: "go",
  java: "java", c: "C", cpp: "C P P", h: "H", rb: "R B", ipynb: "notebook", html: "HTML", css: "CSS",
  lock: "lock", cfg: "config", ini: "I N I", csv: "CSV", pdf: "PDF", png: "PNG", svg: "SVG",
};
const FILE_RE = new RegExp(`^(?:[\\w.~-]+/)*([\\w-]+(?:\\.[\\w-]+)*)\\.(${Object.keys(FILE_EXT).join("|")})$`, "i");

const LEADING_PUNCT = /^[\s"'“”‘’(\[{<«*_~`]+/;
const TRAILING_PUNCT = /[\s"'“”‘’)\]}>»*_~`.,;:!?]+$/;
// Pictographs only — arrows and math symbols (also "Extended_Pictographic") are handled by SYMBOLS.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{25A0}-\u{25FF}\u{2B50}\u{2B55}]\u{FE0F}?/gu;

/** Split identifiers: snake_case, kebab-case, camelCase, and short consonant-only clusters spelled. */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-]+/)
    .filter(Boolean)
    .flatMap((w) => (w.length >= 2 && w.length <= 3 && /^[a-z]+$/i.test(w) && !/[aeiouy]/i.test(w) ? [w.toUpperCase().split("").join(" ")] : [w]))
    .flatMap((w) => w.split(" "));
}

/** Lowercase long ALL-CAPS words so the TTS pronounces rather than spells them ("CLAUDE" → "claude"). */
function decap(w: string): string {
  if (w === "README") return "read me";
  return w.length >= 5 && /^[A-Z]+$/.test(w) && /[AEIOU]/.test(w) ? w.toLowerCase() : w;
}

export function fileNameToSpeech(name: string): string[] | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const [, base = "", ext = ""] = m;
  const baseWords = base.split(".").flatMap((part, i) => (i ? ["dot", ...splitIdentifier(part)] : splitIdentifier(part)));
  const spoken = baseWords
    .map(decap)
    .flatMap((w) => w.split(" "))
    .flatMap((w) => (/^\d+$/.test(w) ? numberToWords(w, { maxDigits: 4 }, false) : /\d/.test(w) ? w.split(/(?<=\d)(?=\D)|(?<=\D)(?=\d)/) : [w]));
  return [...spoken, "dot", ...FILE_EXT[ext.toLowerCase()]!.split(" ")];
}

function urlToSpeech(url: string): string[] | null {
  const m = /^(?:https?:\/\/|www\.)([^/\s?#]+)/i.exec(url);
  if (!m) return null;
  const host = m[1]!.replace(/^www\./, "");
  return ["link", "to", ...host.split(".").flatMap((p, i) => (i ? ["dot", p] : [p]))];
}

function coreToWords(core: string, opts: NormalizeOptions): string[] {
  if (!core) return [];
  if (isNumberToken(core)) return numberToWords(core, opts);
  const out: string[] = [];
  // digits with unit suffix: "22B" → "twenty-two B", "3x" → "three x"
  const unit = /^(\d+(?:\.\d+)?)([A-Za-z]{1,3})$/.exec(core);
  if (unit) {
    const u = unit[2]!;
    const unitWord: Record<string, string> = { x: "times", B: "billion", M: "million", K: "thousand", k: "thousand", ms: "milliseconds", s: "seconds", GB: "gigabytes", MB: "megabytes", KB: "kilobytes", TB: "terabytes" };
    return [...numberToWords(unit[1]!, opts), unitWord[u] ?? u];
  }
  const poss = /^(\d+)['’]s$/.exec(core);
  if (poss) {
    const w = numberToWords(poss[1]!, opts, false);
    w[w.length - 1] += "'s";
    return w;
  }
  // ordinals "1st", "22nd" — leave to TTS
  if (/^\d+(st|nd|rd|th)$/.test(core)) return [core];
  // mixed letters/digits like "W_Q" handled by split; generic word:
  for (const piece of core.split(/(?<=\d)(?=[A-Za-z])|(?<=[A-Za-z])(?=\d)/)) {
    if (isNumberToken(piece)) out.push(...numberToWords(piece, opts, false));
    else out.push(decap(piece));
  }
  return out;
}

/**
 * Normalize one whitespace-free source token into spoken words.
 * Trailing sentence punctuation is kept on the last word so prosody and sentence
 * splitting still work. Returns [] for tokens that should be silent; a lone
 * punctuation string (e.g. [","]) means "attach to the previous word".
 */
export function normalizeToken(token: string, opts: NormalizeOptions): string[] {
  const words = normalizeTokenInner(token, opts);
  // An opening paren/bracket or dash starts an aside: pause before it.
  if (/^[(\[—―]/.test(token.trim()) && words.length && !/^[,.;:!?]$/.test(words[0]!)) return [",", ...words];
  return words;
}

function normalizeTokenInner(token: string, opts: NormalizeOptions): string[] {
  let t = token;
  // possessive glued to a preceding code span / formula: `Linear`'s
  const poss = /^['’]s([,.;:!?]*)$/.exec(t.trim());
  if (poss) return ["'s" + (poss[1] ? poss[1][0] : "")];
  for (const c of CHECKS) {
    if (t.includes(c)) t = t.split(c).join(opts.readCheckmarks ? (c === "✗" || c === "✘" || c === "❌" ? " cross " : " check ") : " ");
  }
  t = t.replace(EMOJI, "");
  if (!t.trim()) return [];
  // a lone dash / bullet / paren is just a pause
  if (/^[—―–·•(\[)\]]*[,.;:]?$/.test(t.trim())) return [/[.!?]/.test(t) ? "." : ","];

  const url = urlToSpeech(t.replace(LEADING_PUNCT, "").replace(TRAILING_PUNCT, ""));
  if (url) return url;

  const lower = t.toLowerCase();
  if (ABBREVIATIONS[lower]) return ABBREVIATIONS[lower]!.split(" ");

  // "~5%" → "about five percent" (before "~" is stripped as punctuation)
  if (/^~\d/.test(t)) return ["about", ...normalizeTokenInner(t.slice(1), opts)];
  const leadStripped = t.replace(LEADING_PUNCT, "");
  const trailMatch = TRAILING_PUNCT.exec(leadStripped);
  const trailRaw = trailMatch ? trailMatch[0] : "";
  let core = trailMatch ? leadStripped.slice(0, trailMatch.index) : leadStripped;
  // keep one meaningful trailing punctuation mark
  // a closing paren/bracket ends an aside: pause after it
  const trail = (/[.!?]/.exec(trailRaw)?.[0] ?? /[,;:]/.exec(trailRaw)?.[0] ?? (/[)\]]/.test(trailRaw) ? "," : "")).replace(";", ",");

  const file = fileNameToSpeech(core);
  if (file) return withTrail(file, trail);

  // thousands separators stay; other commas split ("3,0,4,0")
  if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(core)) core = core.replace(/,/g, " , ");
  // numeric ranges 3–7, 114-117
  core = core.replace(/(\d)[–-](?=\d)/g, "$1 to ");
  // "~5" → about 5
  core = core.replace(/(^|\s)~(?=\d)/g, "$1about ");
  // greek letters
  core = core.replace(/[α-ωΑ-Ω]/g, (g) => (GREEK[g] ? ` ${GREEK[g]} ` : g));
  // symbols (longest first)
  for (const sym of Object.keys(SYMBOLS).sort((a, b) => b.length - a.length)) {
    if (core.includes(sym)) {
      // keep "-" in words and a leading minus on numbers; only symbols in map are replaced
      core = core.split(sym).join(SYMBOLS[sym]!);
    }
  }
  // en dash: joins names ("Cauchy–Schwarz"); otherwise a pause
  core = core.replace(/(?<=\p{L})–(?=\p{L})/gu, "-").replace(/–/g, " , ");
  // dots between identifiers (a.b) → "dot"; leave decimals alone
  core = core.replace(/(?<=[A-Za-z_)\]])\.(?=[A-Za-z_(])/g, " dot ");

  const words: string[] = [];
  let pendingComma = false;
  for (const part of core.split(/\s+/).filter(Boolean)) {
    if (part === ",") {
      if (words.length) words[words.length - 1] = words[words.length - 1]!.replace(/[,.;:!?]+$/, "") + ",";
      else pendingComma = true;
      continue;
    }
    const sub = part.replace(LEADING_PUNCT, "");
    const subTrail = TRAILING_PUNCT.exec(sub);
    const subCore = subTrail ? sub.slice(0, subTrail.index) : sub;
    const ws = coreToWords(subCore, opts);
    words.push(...ws);
    if (subTrail && ws.length && /[,;:]/.test(subTrail[0])) words[words.length - 1] += ",";
  }
  if (!words.length) return trail === "," || trail === "." ? [trail] : pendingComma ? [","] : [];
  return pendingComma ? [",", ...withTrail(words, trail)] : withTrail(words, trail);
}

function withTrail(words: string[], trail: string): string[] {
  if (!trail || !words.length) return words;
  const out = words.slice();
  out[out.length - 1] = out[out.length - 1]!.replace(/[,.;:!?]+$/, "") + trail;
  return out;
}

/** Normalize a free-text string (e.g. math speech output) into words. */
export function normalizeText(text: string, opts: NormalizeOptions): string[] {
  const out: string[] = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    for (const w of normalizeToken(tok, opts)) {
      if (/^[,.;:!?]$/.test(w)) {
        if (out.length) out[out.length - 1] = out[out.length - 1]!.replace(/[,.;:!?]+$/, "") + w;
      } else out.push(w);
    }
  }
  return out;
}
