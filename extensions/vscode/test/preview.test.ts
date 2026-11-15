// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSpeechScript } from "@spokedown/core";
import { renderPreviewHtml } from "../src/previewRender.js";
import { SourceMap } from "../src/webview/sourceMap.js";
import { startPointAtOffset } from "../src/startPoint.js";

const kitchen = fs.readFileSync(path.join(__dirname, "../../../packages/core/test/fixtures/synthetic/kitchen-sink.md"), "utf8");
const qk = fs.readFileSync(path.join(__dirname, "../../../packages/core/test/fixtures/docs/softmax-walkthrough.md"), "utf8");

function mount(src: string): { root: HTMLElement; map: SourceMap } {
  const root = document.createElement("div");
  root.innerHTML = renderPreviewHtml(src);
  document.body.replaceChildren(root);
  return { root, map: new SourceMap(root) };
}

describe("renderPreviewHtml", () => {
  it("tags text spans with offsets that point at the same source text", () => {
    const { map } = mount(kitchen);
    expect(map.texts.length).toBeGreaterThan(20);
    let exact = 0;
    for (const t of map.texts) if (kitchen.slice(t.s, t.e) === t.el.textContent) exact++;
    expect(exact / map.texts.length).toBeGreaterThan(0.95);
  });

  it("renders math with KaTeX, diagrams for mermaid, and no raw $$", () => {
    const html = renderPreviewHtml(qk);
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('<pre class="mermaid"');
    expect(html).not.toContain("katex-error");
    expect(html).not.toMatch(/\$\$/);
  });

  it("renders a one-line $$…$$ paragraph as display math", () => {
    expect(renderPreviewHtml("Before\n\n$$a = b$$\n\nAfter")).toContain("katex-display");
    expect(renderPreviewHtml("Inline $a = b$ here")).not.toContain("katex-display");
  });

  it("rewrites relative image paths through the resolver", () => {
    const html = renderPreviewHtml("![cat](img/cat.png) ![web](https://x.org/a.png)", { resolveImage: (s) => (s.startsWith("http") ? undefined : `vscode-resource:/${s}`) });
    expect(html).toContain('src="vscode-resource:/img/cat.png"');
    expect(html).toContain('src="https://x.org/a.png"');
  });
});

describe("SourceMap", () => {
  it("turns a speech-script word into a DOM range over the same text", async () => {
    const { map } = mount(kitchen);
    const script = await buildSpeechScript(kitchen);
    const seg = script.segments.find((s) => s.text.startsWith("A paragraph with"))!;
    for (const w of seg.words.filter((x) => /^[a-z]+,?$/i.test(x.text)).slice(0, 8)) {
      // inline code words cover the whole `code` span; the DOM shows it without backticks
      expect(map.range(w.srcStart, w.srcEnd)!.toString()).toBe(kitchen.slice(w.srcStart, w.srcEnd).replace(/`/g, ""));
    }
    // a whole sentence spans several text nodes (bold, code, link)
    expect(map.range(...seg.srcRange)!.toString()).toMatch(/^A paragraph with bold, emphasis, inline_code\(\), a link and a bare URL/);
  });

  it("covers a formula as one atomic element", async () => {
    const src = "Text with $x^2$ inside.";
    const { map } = mount(src);
    const s = src.indexOf("$");
    const r = map.range(s, s + 5)!;
    expect(r).not.toBeNull();
    expect(r.toString()).toContain("x");
  });

  it("finds the block element for a table", async () => {
    const { map } = mount(kitchen);
    const s = kitchen.indexOf("| Name");
    const e = kitchen.indexOf("`beta_v2` |") + "`beta_v2` |".length;
    expect(map.elementFor(s, e)?.tagName).toBe("TABLE");
  });

  it("maps a click inside a word back to its source offset", () => {
    const { map } = mount(kitchen);
    const t = map.texts.find((x) => x.el.textContent?.includes("ordered item"))!;
    const node = t.el.firstChild!;
    const i = node.textContent!.indexOf("ordered");
    expect(kitchen.slice(map.offsetAt(node, i)!, map.offsetAt(node, i)! + 7)).toBe("ordered");
  });
});

describe("startPointAtOffset", () => {
  it("starts at the clicked word, mid-sentence", async () => {
    const script = await buildSpeechScript(kitchen);
    const sp = startPointAtOffset(script, kitchen.indexOf("emphasis"));
    expect(script.segments[sp.index]!.words[sp.word]!.text).toBe("emphasis,");
    expect(sp.word).toBeGreaterThan(0);
  });
  it("prefers the table row over the table intro for a click in a cell", async () => {
    const script = await buildSpeechScript(kitchen);
    const sp = startPointAtOffset(script, kitchen.indexOf("alpha"));
    expect(script.segments[sp.index]!.kind).toBe("tableRow");
    expect(script.segments[sp.index]!.words[sp.word]!.text).toBe("alpha,");
  });
});
