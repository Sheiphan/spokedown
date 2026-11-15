// Markdown → preview HTML whose text and blocks carry source offsets (data-s / data-e),
// so the read-along preview can highlight exactly what the speech script points at.
// Uses the same parser as the speech script, so offsets agree. No vscode imports.
import { displayMathTex, parseMarkdown } from "@spokedown/core";
import type { Element, ElementContent, Root as HastRoot, Text } from "hast";
import type { Root as MdRoot } from "mdast";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit, SKIP } from "unist-util-visit";

export interface RenderOptions {
  /** Map a relative image src to a URL the webview can load; return undefined to keep it. */
  resolveImage?: (src: string) => string | undefined;
}

const hasClass = (el: Element, c: string) => {
  const cls = el.properties?.className;
  return Array.isArray(cls) ? cls.includes(c) : cls === c;
};

type Positioned = { position?: { start?: { offset?: number }; end?: { offset?: number } } };
const offsets = (n: Positioned): readonly [number, number] | undefined => {
  const a = n.position?.start?.offset;
  const b = n.position?.end?.offset;
  return a !== undefined && b !== undefined ? [a, b] : undefined;
};

const NO_WRAP = new Set(["pre", "script", "style", "svg", "math", "textarea"]);

/** rehype plugin: source offsets on elements, offset-tagged text spans, math/mermaid wrappers. */
function annotate(opts: RenderOptions & { source: string }) {
  return (tree: HastRoot) => {
    // 1. mermaid blocks → <pre class="mermaid">, math → wrapper that survives KaTeX replacement
    visit(tree, "element", (node: Element, index, parent) => {
      if (!parent || index === undefined) return;
      if (node.tagName === "pre") {
        const code = node.children[0];
        if (code?.type === "element" && code.tagName === "code") {
          if (hasClass(code, "language-mermaid")) {
            const text = code.children.map((c) => (c.type === "text" ? c.value : "")).join("");
            const o = offsets(node);
            parent.children[index] = {
              type: "element",
              tagName: "pre",
              properties: { className: ["mermaid"], ...(o ? { dataS: o[0], dataE: o[1] } : {}) },
              children: [{ type: "text", value: text }],
            };
            return SKIP;
          }
          if (hasClass(code, "language-math")) {
            parent.children[index] = wrap("div", node);
            return SKIP;
          }
        }
      }
      if (node.tagName === "code" && hasClass(node, "language-math")) {
        // `$$…$$` on one line parses as inline math; render it as a display equation like VS Code does
        const o = offsets(node);
        const display = o !== undefined && opts.source.startsWith("$$", o[0]);
        if (display) node.properties.className = ["language-math", "math-display"];
        parent.children[index] = wrap(display ? "div" : "span", node);
        return SKIP;
      }
      if (node.tagName === "img" && opts.resolveImage && typeof node.properties.src === "string") {
        const r = opts.resolveImage(node.properties.src);
        if (r) node.properties.src = r;
      }
    });

    // 2. offsets on every element; plain text wrapped in offset-tagged spans
    const walk = (node: HastRoot | Element, inNoWrap: boolean) => {
      const children = node.children as ElementContent[];
      for (let i = 0; i < children.length; i++) {
        const c = children[i]!;
        if (c.type === "element") {
          const o = offsets(c);
          if (o && c.properties.dataS === undefined) {
            c.properties.dataS = o[0];
            c.properties.dataE = o[1];
          }
          const skip = inNoWrap || NO_WRAP.has(c.tagName) || hasClass(c, "mdr-math") || hasClass(c, "mermaid");
          walk(c, skip);
        } else if (c.type === "text" && !inNoWrap && c.value.trim()) {
          const o = offsets(c);
          if (!o) continue;
          const spans = exactSpans(opts.source, o[0], o[1], c.value);
          children.splice(i, 1, ...spans);
          i += spans.length - 1;
        }
      }
    };
    walk(tree, false);
  };
}

const textSpan = (value: string, s: number, e: number): Element => ({
  type: "element",
  tagName: "span",
  properties: { className: ["mdr-t"], dataS: s, dataE: e },
  children: [{ type: "text", value }],
});

/**
 * Offset-tagged spans for a text node so that each span's text equals the source
 * slice it points at. The rendered text can differ from the source (inline code
 * drops its backticks; blockquote / list continuation lines drop their "> " or
 * indent), so locate the text — or each of its lines — inside the node's range.
 */
function exactSpans(source: string, s: number, e: number, value: string): ElementContent[] {
  const slice = source.slice(s, e);
  if (slice === value) return [textSpan(value, s, e)];
  const k = slice.indexOf(value);
  if (k >= 0) return [textSpan(value, s + k, s + k + value.length)];
  const out: ElementContent[] = [];
  let cursor = 0;
  value.split("\n").forEach((line, li) => {
    if (li > 0) out.push({ type: "text", value: "\n" });
    if (!line) return;
    const trimmed = line.trim();
    const at = trimmed ? slice.indexOf(trimmed, cursor) : -1;
    if (at < 0) {
      out.push(textSpan(line, s, e)); // can't place it exactly: whole-node range
      return;
    }
    const lead = line.indexOf(trimmed);
    if (lead > 0) out.push({ type: "text", value: line.slice(0, lead) });
    out.push(textSpan(trimmed, s + at, s + at + trimmed.length));
    if (lead + trimmed.length < line.length) out.push({ type: "text", value: line.slice(lead + trimmed.length) });
    cursor = at + trimmed.length;
  });
  return out;
}

function wrap(tag: "span" | "div", node: Element): Element {
  const o = offsets(node);
  return { type: "element", tagName: tag, properties: { className: ["mdr-math"], ...(o ? { dataS: o[0], dataE: o[1] } : {}) }, children: [node] };
}

export function renderPreviewHtml(source: string, opts: RenderOptions = {}): string {
  const tree = parseMarkdown(source) as MdRoot;
  // display math: the parser sees a rewritten copy; take the TeX from the original source
  visit(tree, "math", (node: { value: string } & Positioned) => {
    const o = offsets(node);
    if (!o) return;
    node.value = displayMathTex(source, o[0], o[1]);
    // mdast-util-math pre-builds the hast at parse time (data.hChildren); keep it in sync
    const code = (node as { data?: { hChildren?: Element[] } }).data?.hChildren?.[0];
    if (code?.type === "element") code.children = [{ type: "text", value: node.value }];
  });
  const p = unified()
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(annotate, { ...opts, source })
    .use(rehypeKatex, { strict: false, output: "htmlAndMathml" as const })
    .use(rehypeHighlight, { detect: false })
    .use(rehypeStringify);
  const hast = p.runSync(tree as never) as HastRoot;
  return p.stringify(hast);
}
