import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import type { Root } from "mdast";

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ["yaml", "toml"]).use(remarkMath);

/**
 * remark-math only recognises display math whose `$$` delimiters sit on their own
 * lines. Many docs write `$$X = …` / `…\end{bmatrix}$$`. Rewrite those delimiter
 * lines in a *copy* of the source to bare `$$` + spaces, preserving length and
 * newlines so every node offset still points into the original text.
 */
export function normalizeDisplayMath(src: string): string {
  const lines = src.split("\n");
  let inFence: string | null = null;
  let open = -1; // line index of an opening $$ we are inside
  const blank = (line: string): string => {
    const indent = /^\s*/.exec(line)![0];
    return indent + "$$" + " ".repeat(Math.max(line.length - indent.length - 2, 0));
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (open < 0) {
      const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (inFence) {
        if (fence && fence[0] === inFence[0] && fence.length >= inFence.length && !trimmed.slice(fence.length).trim()) inFence = null;
        continue;
      }
      if (fence) {
        inFence = fence;
        continue;
      }
      if (trimmed.startsWith("$$")) {
        const rest = trimmed.slice(2);
        if (rest.includes("$$")) continue; // single-line $$…$$ — parsed as inline math, handled by the builder
        open = i;
        if (rest.trim()) lines[i] = blank(line);
      }
    } else if (trimmed.includes("$$")) {
      if (trimmed !== "$$") lines[i] = blank(line);
      open = -1;
    }
  }
  return lines.join("\n");
}

/** Parse Markdown into an mdast tree; every node carries offsets into `source`. */
export function parseMarkdown(source: string): Root {
  const prepared = normalizeDisplayMath(source);
  return processor.runSync(processor.parse(prepared)) as Root;
}

/** TeX inside a display-math node, read from the original source. */
export function displayMathTex(source: string, start: number, end: number): string {
  const s = source.slice(start, end);
  const a = s.indexOf("$$");
  const b = s.lastIndexOf("$$");
  return a >= 0 && b > a ? s.slice(a + 2, b).trim() : s.trim();
}
