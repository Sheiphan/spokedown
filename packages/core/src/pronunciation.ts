// User pronunciation dictionary: "kubectl" → "kube control", "K8s" → "kates", "" → silent.
//
// Matching is done on the *source* text of each word (so `K8s`, `` `kubectl` `` and "Claude Code"
// work even though the speech pipeline has already split or rewritten them), with a
// per-spoken-word fallback inside identifiers (`kubectl_apply` → "kube control apply").
// Keys with an uppercase letter match exactly; all-lowercase keys ignore case.
// Replacement words keep the source range of what they replace, so highlighting still works.
import type { Word } from "./types.js";

export type PronunciationMap = Record<string, string>;

interface Entry {
  tokens: string[];
  exact: boolean;
  replacement: string[];
}

export interface CompiledPronunciations {
  entries: Entry[];
}

const MAX_TOKEN_CHARS = 80;
// Markup and punctuation that surrounds a word in the source but is not part of it.
const EDGE = /^[`*_~"'“”‘’()\[\]{}<>.,;:!?]+|[`*_~"'“”‘’()\[\]{}<>.,;:!?]+$/g;
const TRAIL = /[,.;:!?]+$/;

export function compilePronunciations(map: PronunciationMap | undefined): CompiledPronunciations | undefined {
  if (!map) return undefined;
  const entries: Entry[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "string") continue;
    const tokens = key.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    entries.push({ tokens, exact: /[A-Z]/.test(key), replacement: value.trim().split(/\s+/).filter(Boolean) });
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => b.tokens.length - a.tokens.length); // "Claude Code" before "Claude"
  return { entries };
}

const same = (a: string, b: string, exact: boolean) => (exact ? a === b : a.toLowerCase() === b.toLowerCase());

/** The source text a group of words came from, without surrounding markup. */
function sourceToken(src: string, w: Word): string | undefined {
  if (w.srcEnd - w.srcStart > MAX_TOKEN_CHARS) return undefined; // a whole block, not a token
  return src.slice(w.srcStart, w.srcEnd).replace(EDGE, "");
}

function substitute(replacement: string[], range: [number, number], trail: string): Word[] {
  const out = replacement.map((text) => ({ text, srcStart: range[0], srcEnd: range[1] }));
  if (trail && out.length) out[out.length - 1]!.text += trail;
  return out;
}

export function applyPronunciations(words: Word[], src: string, dict: CompiledPronunciations): Word[] {
  // Consecutive words from one source token form a group ("kubectl_apply" → two words, one range).
  const groups: Word[][] = [];
  for (const w of words) {
    const g = groups[groups.length - 1];
    if (g && g[0]!.srcStart === w.srcStart && g[0]!.srcEnd === w.srcEnd) g.push(w);
    else groups.push([w]);
  }
  const tokens = groups.map((g) => sourceToken(src, g[0]!));

  const out: Word[] = [];
  let i = 0;
  while (i < groups.length) {
    let done = false;
    for (const e of dict.entries) {
      const k = e.tokens.length;
      if (i + k > groups.length) continue;
      let ok = true;
      for (let j = 0; j < k && ok; j++) {
        const t = tokens[i + j];
        ok = t !== undefined && same(t, e.tokens[j]!, e.exact);
      }
      if (!ok) continue;
      const first = groups[i]![0]!;
      const lastGroup = groups[i + k - 1]!;
      const last = lastGroup[lastGroup.length - 1]!;
      out.push(...substitute(e.replacement, [first.srcStart, last.srcEnd], TRAIL.exec(last.text)?.[0] ?? ""));
      i += k;
      done = true;
      break;
    }
    if (done) continue;

    // Fallback: single-word keys against each spoken word (parts of identifiers, math words, …).
    for (const w of groups[i]!) {
      const trail = TRAIL.exec(w.text)?.[0] ?? "";
      const core = trail ? w.text.slice(0, -trail.length) : w.text;
      const hit = dict.entries.find((e) => e.tokens.length === 1 && same(core, e.tokens[0]!, e.exact));
      if (hit) out.push(...substitute(hit.replacement, [w.srcStart, w.srcEnd], trail));
      else out.push(w);
    }
    i++;
  }
  return out;
}
