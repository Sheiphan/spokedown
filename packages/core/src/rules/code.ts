// Inline code and fenced code blocks.
import { fileNameToSpeech, normalizeText, splitIdentifier, type NormalizeOptions } from "../normalize.js";
import { numberToWords } from "../numbers.js";

const LANG_NAMES: Record<string, string> = {
  py: "Python", python: "Python", js: "JavaScript", javascript: "JavaScript", mjs: "JavaScript",
  ts: "TypeScript", typescript: "TypeScript", tsx: "TypeScript", jsx: "JavaScript",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "terminal", powershell: "PowerShell",
  json: "JSON", jsonc: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", ini: "config",
  rust: "Rust", rs: "Rust", go: "Go", java: "Java", kotlin: "Kotlin", swift: "Swift",
  c: "C", cpp: "C plus plus", "c++": "C plus plus", cs: "C sharp", csharp: "C sharp",
  rb: "Ruby", ruby: "Ruby", php: "PHP", sql: "SQL", html: "HTML", xml: "XML", css: "CSS",
  diff: "diff", patch: "diff", dockerfile: "Dockerfile", make: "Makefile", makefile: "Makefile",
  r: "R", lua: "Lua", scala: "Scala", haskell: "Haskell", latex: "LaTeX", tex: "LaTeX",
  md: "Markdown", markdown: "Markdown", graphql: "GraphQL", proto: "protobuf",
};

export function languageName(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  return LANG_NAMES[l] ?? lang;
}

/** A fence with no language whose content is mostly numbers/brackets is a data dump, not code. */
export function isDataBlock(lang: string | null | undefined, value: string): boolean {
  if (lang && !["text", "txt", "plain", "plaintext", "output", "log", ""].includes(lang.toLowerCase())) return false;
  const body = value.replace(/\s+/g, "");
  if (!body.length) return false;
  const numeric = body.replace(/[^0-9.,\-+eE\[\]()]/g, "").length;
  return numeric / body.length >= 0.6;
}

const OPERATORS: [RegExp, string][] = [
  [/->|=>/g, " to "], [/==/g, " equals equals "], [/!=/g, " not equals "], [/<=/g, " less or equal "],
  [/>=/g, " greater or equal "], [/\*\*/g, " power "], [/\+=/g, " plus equals "], [/-=/g, " minus equals "],
  [/:=/g, " colon equals "], [/=/g, " equals "], [/\+/g, " plus "], [/(?<=\w|\))\s*\*\s*(?=\w|\()/g, " times "],
  [/@/g, " at "], [/(?<=[\w)\]])\.(?=[A-Za-z_])/g, " dot "], [/[()[\]{}]/g, " "], [/,/g, " , "],
  [/[:;`'"#$\\|^~*]/g, " "], [/</g, " less than "], [/>/g, " greater than "], [/&&/g, " and "], [/\|\|/g, " or "],
  [/(^|[\s(=,])-(?=\d)/g, "$1 minus "], [/(?<=\w)\s*-\s*(?=\w)/g, " minus "], [/\//g, " slash "], [/%/g, " mod "],
];

/** Speech for an inline code span. */
export function codeToSpeech(code: string, opts: NormalizeOptions, maxChars = 60): string[] {
  const c = code.trim();
  if (!c) return [];

  // path or file with optional :line or :start-end — "attention.py:183"
  const pathLine = /^((?:[\w.~-]+\/)*[\w.-]+\.\w+)(?::(\d+)(?:-(\d+))?)?(?:#L(\d+))?$/.exec(c);
  if (pathLine) {
    const file = fileNameToSpeech(pathLine[1]!.split("/").pop()!);
    if (file) {
      const out = [...file];
      const start = pathLine[2] ?? pathLine[4];
      if (start && pathLine[3]) out.push("lines", ...numberToWords(start, opts, false), "to", ...numberToWords(pathLine[3], opts, false));
      else if (start) out.push("line", ...numberToWords(start, opts, false));
      if (start) out[file.length - 1] += ",";
      return out;
    }
  }
  // shape tuple "(1, 3, 8)"
  if (/^\(\s*\d+(\s*,\s*\d+)*\s*,?\s*\)$/.test(c)) {
    const nums = c.match(/\d+/g)!;
    const out = ["shape"];
    nums.forEach((n, i) => {
      const w = numberToWords(n, opts, false);
      if (i < nums.length - 1) w[w.length - 1] += ",";
      out.push(...w);
    });
    return out;
  }
  if (c.length > maxChars) return ["a", "code", "snippet"];

  // file paths inside commands: speak only the file name ("scripts/check_001.py" → "check zero zero one dot P Y")
  const withFiles = c.replace(/(?:[\w.~-]*\/)*([\w-]+(?:\.[\w-]+)*\.\w+)(?=$|[\s,;)\]])/g, (m, name: string) => {
    const file = fileNameToSpeech(name);
    return file ? ` ${file.join(" ")} ` : m;
  });
  // other paths: keep the last component
  const noPaths = withFiles.replace(/(?:[\w.~-]+\/)+([\w.-]+)/g, "$1").replace(/^\./, "");
  return operatorWords(noPaths, opts);
}

function operatorWords(code: string, opts: NormalizeOptions): string[] {
  let s = code.replace(/\butf-?(8|16|32)\b/gi, "UTF $1");
  for (const [re, rep] of OPERATORS) s = s.replace(re, rep);
  const words: string[] = [];
  for (const tok of s.split(/\s+/).filter(Boolean)) {
    if (tok === ",") {
      if (words.length) words[words.length - 1] += ",";
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(tok)) {
      words.push(...normalizeText(tok, opts));
      continue;
    }
    words.push(...splitIdentifier(tok).flatMap((w) => normalizeText(w, opts)));
  }
  return words;
}

export interface CodeBlockDescription {
  kind: "code" | "data";
  words: string[];
}

function countWords(n: number, opts: NormalizeOptions, unit: string): string[] {
  return [...numberToWords(String(n), opts, false), n === 1 ? unit : `${unit}s`];
}

export function describeCodeBlock(lang: string | null | undefined, value: string, opts: NormalizeOptions): CodeBlockDescription {
  const lines = value.replace(/\n+$/, "").split("\n").length;
  if (isDataBlock(lang, value)) {
    return { kind: "data", words: ["Data", "block,", ...countWords(lines, opts, "line")].map((w, i, a) => (i === a.length - 1 ? `${w}.` : w)) };
  }
  const name = languageName(lang);
  const head = name ? [...name.split(" "), "code", "block,"] : ["Code", "block,"];
  const words = [...head, ...countWords(lines, opts, "line")];
  words[words.length - 1] += ".";
  return { kind: "code", words };
}
