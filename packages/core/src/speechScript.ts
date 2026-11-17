// mdast → SpeechScript: spoken segments, each word mapped to its source range.
import type {
  Blockquote, Code, Heading, List, ListItem, Node, Paragraph, Parent, PhrasingContent, RootContent, Table, Text,
} from "mdast";
import { displayMathTex, parseMarkdown } from "./parse.js";
import { normalizeToken } from "./normalize.js";
import { applyPronunciations, compilePronunciations, type CompiledPronunciations } from "./pronunciation.js";
import { numberToWords } from "./numbers.js";
import { resolveOptions, type ReaderOptions, type ReaderOptionsInput } from "./options.js";
import { codeToSpeech, describeCodeBlock } from "./rules/code.js";
import { describeMermaid } from "./rules/mermaid.js";
import { initMath, texToWords } from "./rules/math.js";
import type { HeadingInfo, Segment, SegmentKind, SpeechScript, Word } from "./types.js";

type Range = [number, number];

const PUNCT_ONLY = /^[,.;:!?]+$/;
const NOT_SENTENCE_END = new Set(["al.", "mr.", "mrs.", "ms.", "dr.", "prof.", "st.", "no.", "vol.", "pp.", "ch.", "sec."]);
const ALERTS: Record<string, string> = { NOTE: "Note.", TIP: "Tip.", IMPORTANT: "Important.", WARNING: "Warning.", CAUTION: "Caution." };

function range(node: Node): Range {
  return [node.position?.start.offset ?? 0, node.position?.end.offset ?? 0];
}

function words(texts: string[], r: Range): Word[] {
  return texts.map((text) => ({ text, srcStart: r[0], srcEnd: r[1] }));
}

const SUFFIX = /^(s|es|th|st|nd|rd|ed|ing|'s)[,.;:!?]?$/;

/**
 * Append spoken words, attaching punctuation-only items to the previous word.
 * When the new source range touches the previous word's range with no space
 * between (e.g. `$i$-th`, `$1$s`, `length-$8$`, `` `Linear`'s ``), the first new
 * word is glued onto the previous one so it is spoken as one word.
 */
function pushWords(out: Word[], spoken: string[], r: Range): void {
  const prev = out[out.length - 1];
  const first = spoken.find((w) => !PUNCT_ONLY.test(w));
  if (prev && first && prev.srcEnd === r[0] && spoken[0] === first) {
    const glue = (/-$/.test(prev.text) || /^[-'’]/.test(first) || SUFFIX.test(first)) && !/[,.;:!?]$/.test(prev.text);
    if (glue) {
      prev.text += first;
      prev.srcEnd = r[1];
      spoken = spoken.slice(1);
    }
  }
  for (const w of spoken) {
    const last = out[out.length - 1];
    if (last && w.toLowerCase() === "the" && last.text.toLowerCase() === "the") continue;
    if (PUNCT_ONLY.test(w)) {
      const last = out[out.length - 1];
      if (last) last.text = last.text.replace(/[,.;:!?]+$/, "") + w[0];
      continue;
    }
    out.push({ text: w, srcStart: r[0], srcEnd: r[1] });
  }
}

function endWith(ws: Word[], p: string): void {
  const last = ws[ws.length - 1];
  if (last) last.text = last.text.replace(/[,.;:!?]+$/, "") + p;
}

function isSentenceEnd(w: string): boolean {
  return /[.!?]$/.test(w) && !NOT_SENTENCE_END.has(w.toLowerCase());
}

class Builder {
  segments: Segment[] = [];
  headings: HeadingInfo[] = [];
  private pendingPause = 0;
  private skipUntil = -1;

  private pron: CompiledPronunciations | undefined;

  constructor(private src: string, private opts: ReaderOptions) {
    this.pron = compilePronunciations(opts.pronunciations);
  }

  // ---------- emitting ----------

  private emit(kind: SegmentKind, mode: Segment["mode"], ws: Word[], blockRange: Range, pauseBefore: number, pauseAfter: number): void {
    if (this.pron) ws = applyPronunciations(ws, this.src, this.pron);
    if (!ws.length) return;
    const sentences: Word[][] = [];
    let cur: Word[] = [];
    for (const w of ws) {
      cur.push(w);
      if (isSentenceEnd(w.text)) {
        sentences.push(cur);
        cur = [];
      }
    }
    if (cur.length) sentences.push(cur);

    const chunks = sentences.flatMap((s) => this.chunk(s));
    chunks.forEach((c, i) => {
      const seg: Segment = {
        id: this.segments.length,
        kind,
        mode,
        text: c.map((w) => w.text).join(" "),
        words: c,
        srcRange: [Math.min(...c.map((w) => w.srcStart)), Math.max(...c.map((w) => w.srcEnd))],
        blockRange,
        pauseBefore: i === 0 ? Math.max(pauseBefore, this.pendingPause) : 0,
        // inside a block: a short gap after a finished sentence, half of it after a mid-sentence split
        pauseAfter: i === chunks.length - 1 ? pauseAfter : isSentenceEnd(c[c.length - 1]!.text) ? this.opts.pauses.sentence : Math.round(this.opts.pauses.sentence / 2),
      };
      this.segments.push(seg);
    });
    this.pendingPause = 0;
  }

  /** Split a long sentence at clause boundaries so each chunk fits the TTS context. */
  private chunk(ws: Word[]): Word[][] {
    const max = this.opts.maxSegmentChars;
    const out: Word[][] = [];
    let rest = ws;
    while (rest.map((w) => w.text).join(" ").length > max) {
      let len = 0;
      let cut = -1;
      let hardCut = 1;
      for (let i = 0; i < rest.length; i++) {
        len += rest[i]!.text.length + 1;
        if (len > max) break;
        hardCut = i + 1;
        if (/[,;:]$/.test(rest[i]!.text) && len > max * 0.4) cut = i + 1;
      }
      const at = cut > 0 ? cut : hardCut;
      out.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    if (rest.length) out.push(rest);
    return out;
  }

  // ---------- inline ----------

  private textTokens(node: Text): { tok: string; r: Range }[] {
    const [s, e] = range(node);
    const raw = this.src.slice(s, e);
    const out: { tok: string; r: Range }[] = [];
    let cursor = 0;
    for (const m of node.value.matchAll(/\S+/g)) {
      const tok = m[0];
      let r: Range;
      if (raw === node.value) r = [s + m.index!, s + m.index! + tok.length];
      else {
        const idx = raw.indexOf(tok, cursor);
        if (idx >= 0) {
          r = [s + idx, s + idx + tok.length];
          cursor = idx + tok.length;
        } else r = [s, e];
      }
      if (r[0] < this.skipUntil) continue;
      out.push({ tok, r });
    }
    return out;
  }

  private async inline(nodes: PhrasingContent[], out: Word[]): Promise<void> {
    for (const n of nodes) {
      switch (n.type) {
        case "text":
          for (const { tok, r } of this.textTokens(n)) pushWords(out, normalizeToken(tok, this.opts), r);
          break;
        case "emphasis":
        case "strong":
        case "delete":
        case "link":
        case "linkReference":
          await this.inline(n.children as PhrasingContent[], out);
          break;
        case "inlineCode":
          pushWords(out, codeToSpeech(n.value, this.opts), range(n));
          break;
        case "inlineMath": {
          if (this.opts.mathInline === "announce") {
            pushWords(out, ["a", "formula"], range(n));
            break;
          }
          const m = await texToWords(n.value, false, this.opts);
          pushWords(out, m.words.length > this.opts.mathInlineMaxWords ? ["a", "formula"] : m.words, range(n));
          break;
        }
        case "image":
        case "imageReference":
          if (this.opts.images === "alt") pushWords(out, n.alt ? ["image:", ...n.alt.split(/\s+/)] : ["an", "image"], range(n));
          break;
        default:
          // break, html, footnoteReference: silent
          break;
      }
    }
  }

  private async inlineWords(node: Parent): Promise<Word[]> {
    const out: Word[] = [];
    await this.inline(node.children as PhrasingContent[], out);
    return out;
  }

  // ---------- blocks ----------

  async blocks(nodes: RootContent[], kind?: SegmentKind): Promise<void> {
    for (const n of nodes) await this.block(n, kind);
  }

  private async block(n: RootContent, kindOverride?: SegmentKind): Promise<void> {
    const p = this.opts.pauses;
    switch (n.type) {
      case "heading":
        return this.heading(n);
      case "paragraph": {
        // a paragraph that is only `$$…$$` on one line is display math
        const real = n.children.filter((c) => !(c.type === "text" && !c.value.trim()));
        if (real.length === 1 && real[0]!.type === "inlineMath" && this.src.startsWith("$$", range(real[0]!)[0])) {
          return this.displayMath(displayMathTex(this.src, ...range(n)), range(n));
        }
        const ws = await this.inlineWords(n);
        const onlyImage = n.children.every((c) => c.type === "image" || (c.type === "text" && !c.value.trim()));
        this.emit(onlyImage ? "image" : (kindOverride ?? "paragraph"), "read", ws, range(n), 0, p.paragraph);
        return;
      }
      case "list":
        return this.list(n, kindOverride);
      case "blockquote":
        return this.blockquote(n);
      case "table":
        return this.table(n);
      case "code":
        return this.code(n);
      case "math":
        return this.displayMath(displayMathTex(this.src, ...range(n)), range(n));
      case "yaml":
      case "toml" as RootContent["type"]:
        return this.frontmatter((n as { value: string }).value, range(n));
      case "thematicBreak":
        this.pendingPause = Math.max(this.pendingPause, p.thematicBreak);
        return;
      case "footnoteDefinition":
        if (this.opts.footnotes === "read") {
          const cue = words(["Footnote", ...n.identifier.split(/\s+/)], range(n));
          endWith(cue, ".");
          this.emit("paragraph", "announce", cue, range(n), p.block, 0);
          await this.blocks(n.children as RootContent[]);
        }
        return;
      default:
        // html, definition: silent
        return;
    }
  }

  private async heading(n: Heading): Promise<void> {
    const ws = await this.inlineWords(n);
    if (!ws.length) return;
    endWith(ws, ".");
    const id = this.segments.length;
    const p = this.opts.pauses;
    this.emit("heading", "read", ws, range(n), n.depth <= 2 ? p.heading : p.block, p.afterHeading);
    this.headings.push({ level: n.depth, text: ws.map((w) => w.text).join(" "), srcRange: range(n), segmentId: id });
  }

  private async list(n: List, kindOverride?: SegmentKind): Promise<void> {
    const start = n.start ?? 1;
    for (const [i, item] of (n.children as ListItem[]).entries()) {
      const [itemStart] = range(item);
      const first = item.children[0];
      const markerRange: Range = [itemStart, first ? range(first)[0] : range(item)[1]];
      const prefix: string[] = [];
      if (n.ordered) prefix.push(...numberToWords(String(start + i), this.opts, false));
      if (item.checked === true) prefix.push("done");
      if (item.checked === false) prefix.push("to", "do");
      if (prefix.length) prefix[prefix.length - 1] += ",";

      let rest = item.children as RootContent[];
      if (first?.type === "paragraph") {
        const ws = [...words(prefix, markerRange), ...(await this.inlineWords(first as Paragraph))];
        this.emit(kindOverride ?? "listItem", "read", ws, range(item), 0, this.opts.pauses.paragraph / 2);
        rest = rest.slice(1);
      }
      await this.blocks(rest, kindOverride);
    }
    this.pendingPause = Math.max(this.pendingPause, this.opts.pauses.paragraph);
  }

  private async blockquote(n: Blockquote): Promise<void> {
    const first = n.children[0];
    if (first?.type === "paragraph") {
      const lead = first.children[0];
      const alert = lead?.type === "text" ? /^\[!(\w+)\]/.exec(lead.value) : null;
      if (alert && lead) {
        const [s] = range(lead);
        const cue = ALERTS[alert[1]!.toUpperCase()] ?? `${alert[1]}.`;
        this.emit("quote", "announce", words([cue], [s, s + alert[0].length]), range(n), this.opts.pauses.block, 0);
        this.skipUntil = s + alert[0].length;
      } else if (lead?.type === "strong") {
        this.pendingPause = Math.max(this.pendingPause, this.opts.pauses.block);
      }
    }
    await this.blocks(n.children as RootContent[], "quote");
    this.skipUntil = -1;
    this.pendingPause = Math.max(this.pendingPause, this.opts.pauses.block);
  }

  private async table(n: Table): Promise<void> {
    if (this.opts.tables === "skip") return;
    const tr = range(n);
    const [header, ...body] = n.children;
    if (!header) return;
    const labels: Word[][] = [];
    for (const cell of header.children) labels.push(await this.inlineWords(cell));
    const ncols = header.children.length;

    const intro: Word[] = words(["Table,", ...numberToWords(String(ncols), this.opts, false), ncols === 1 ? "column" : "columns"], tr);
    const named = labels.filter((l) => l.length);
    if (named.length) {
      endWith(intro, ":");
      named.forEach((l, i) => {
        const copy = l.map((w) => ({ ...w }));
        endWith(copy, ",");
        intro.push(...copy);
      });
    } else endWith(intro, ",");
    intro.push(...words([...numberToWords(String(body.length), this.opts, false), body.length === 1 ? "row." : "rows."], tr));
    this.emit("tableIntro", "announce", intro, tr, this.opts.pauses.block, this.opts.pauses.paragraph);
    if (this.opts.tables === "announce") return;

    for (const [ri, row] of body.entries()) {
      const rr = range(row);
      const ws: Word[] = words(["Row", ...numberToWords(String(ri + 1), this.opts, false)], [rr[0], row.children[0] ? range(row.children[0])[0] + 1 : rr[1]]);
      endWith(ws, ":");
      for (const [ci, cell] of row.children.entries()) {
        const cr = range(cell);
        const label = labels[ci] ?? [];
        if (label.length) {
          const l = label.map((w) => ({ text: w.text, srcStart: cr[0], srcEnd: cr[1] }));
          endWith(l, ":");
          ws.push(...l);
        }
        const content = await this.inlineWords(cell);
        ws.push(...(content.length ? content : words(["empty"], cr)));
        endWith(ws, ci === row.children.length - 1 ? "." : ",");
      }
      this.emit("tableRow", "read", ws, tr, 0, this.opts.pauses.paragraph);
    }
    this.pendingPause = Math.max(this.pendingPause, this.opts.pauses.block);
  }

  private async code(n: Code): Promise<void> {
    const r = range(n);
    const p = this.opts.pauses;
    if (n.lang?.toLowerCase() === "mermaid") {
      if (this.opts.mermaid === "skip") return;
      this.emit("diagram", "announce", words(describeMermaid(n.value, this.opts), r), r, p.block, p.block);
      return;
    }
    const desc = describeCodeBlock(n.lang, n.value, this.opts);
    if (desc.kind === "data") {
      if (this.opts.dataBlocks === "skip") return;
      this.emit("data", "announce", words(desc.words, r), r, p.block, p.block);
      return;
    }
    if (this.opts.code === "skip") return;
    this.emit("code", "announce", words(desc.words, r), r, p.block, this.opts.code === "read" ? p.paragraph : p.block);
    if (this.opts.code !== "read") return;

    // read line by line, each line mapped to its own source range
    const contentStart = this.src.indexOf("\n", r[0]) + 1;
    let offset = contentStart;
    const lines = n.value.split("\n");
    const max = this.opts.codeReadMaxLines;
    for (const [i, line] of lines.entries()) {
      const lr: Range = [offset, Math.min(offset + line.length, r[1])];
      offset += line.length + 1;
      if (i >= max) {
        const more = lines.length - max;
        this.emit("code", "announce", words([...numberToWords(String(more), this.opts, false), more === 1 ? "more line." : "more lines."], r), r, 0, p.block);
        return;
      }
      const ws = codeToSpeech(line, this.opts, Infinity);
      if (!ws.length) continue;
      const lw = words(ws, lr);
      endWith(lw, ".");
      this.emit("code", "read", lw, r, 0, 0);
    }
    this.pendingPause = Math.max(this.pendingPause, p.block);
  }

  private async displayMath(tex: string, r: Range): Promise<void> {
    const p = this.opts.pauses;
    const lines = tex.trim().split("\n").length;
    const announce = (): string[] => (lines > 2 ? ["Equation,", ...numberToWords(String(lines), this.opts, false), "lines."] : ["Equation."]);
    if (this.opts.mathDisplay === "announce") {
      this.emit("math", "announce", words(announce(), r), r, p.block, p.block);
      return;
    }
    const m = await texToWords(tex, true, this.opts);
    if (m.failed || (this.opts.mathDisplay === "short" && m.words.length > this.opts.mathShortMaxWords)) {
      this.emit("math", "announce", words(announce(), r), r, p.block, p.block);
      return;
    }
    const ws = words(m.words, r);
    endWith(ws, ".");
    this.emit("math", "read", ws, r, p.block, p.block);
  }

  private frontmatter(value: string, r: Range): void {
    const isSkill = /(^|\/)skill\.md$/i.test(this.opts.fileName ?? "");
    const field = (k: string): string | undefined =>
      new RegExp(`^${k}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(value)?.[1];
    if (isSkill) {
      const name = field("name");
      const desc = field("description");
      const ws: string[] = [];
      if (name) ws.push("Skill:", ...name.split(/[\s_-]+/).map((w) => w), ".");
      if (desc) ws.push(...desc.split(/\s+/));
      const out: Word[] = [];
      pushWords(out, ws.flatMap((w) => (w === "." ? ["."] : normalizeToken(w, this.opts))), r);
      endWith(out, ".");
      this.emit("frontmatter", "announce", out, r, 0, this.opts.pauses.block);
      return;
    }
    if (this.opts.frontmatter === "skip") return;
    const title = field("title");
    const out: Word[] = [];
    pushWords(out, title ? ["Title:", ...title.split(/\s+/).flatMap((w) => normalizeToken(w, this.opts))] : ["Front", "matter."], r);
    endWith(out, ".");
    this.emit("frontmatter", "announce", out, r, 0, this.opts.pauses.block);
  }
}

/** Build the speech script for a Markdown document. */
export async function buildSpeechScript(source: string, options: ReaderOptionsInput = {}): Promise<SpeechScript> {
  const opts = resolveOptions(options);
  const tree = parseMarkdown(source);
  if (/\$/.test(source)) await initMath();
  const b = new Builder(source, opts);
  await b.blocks(tree.children);
  return { segments: b.segments, headings: b.headings };
}

/**
 * The segment to start reading from for a cursor at `offset`: the most specific
 * segment containing it (a table row rather than the table intro), else the
 * next segment after it.
 */
export function segmentAtOffset(script: SpeechScript, offset: number): Segment | undefined {
  let best: Segment | undefined;
  for (const s of script.segments) {
    if (s.srcRange[0] <= offset && offset < s.srcRange[1]) {
      if (!best || s.srcRange[1] - s.srcRange[0] < best.srcRange[1] - best.srcRange[0]) best = s;
    }
  }
  return best ?? script.segments.find((s) => s.srcRange[0] >= offset);
}
