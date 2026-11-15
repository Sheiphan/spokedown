// Maps Markdown source offsets ↔ DOM positions in the rendered preview, using the
// data-s / data-e attributes written by previewRender.ts. Pure DOM (tested with jsdom).

interface Entry {
  el: HTMLElement;
  s: number;
  e: number;
}

export interface DomPoint {
  node: Node;
  offset: number;
}

export class SourceMap {
  /** Offset-tagged text spans, in document order. */
  readonly texts: Entry[] = [];
  /** Every offset-tagged element (blocks, inline code, math, …). */
  readonly elements: Entry[] = [];

  constructor(root: ParentNode) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-s]"))) {
      const s = Number(el.dataset.s);
      const e = Number(el.dataset.e);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) continue;
      const entry = { el, s, e };
      this.elements.push(entry);
      if (el.classList.contains("mdr-t")) this.texts.push(entry);
    }
  }

  /** Character index inside a text span for a source offset (exact when lengths agree). */
  private charIndex(t: Entry, off: number): number {
    const len = t.el.textContent?.length ?? 0;
    const span = t.e - t.s;
    const rel = Math.max(0, Math.min(off - t.s, span));
    return span === len ? rel : Math.round((rel * len) / Math.max(span, 1));
  }

  /** Smallest element whose range contains [s, e). */
  elementFor(s: number, e: number): HTMLElement | undefined {
    let best: Entry | undefined;
    for (const x of this.elements) {
      if (x.s <= s && x.e >= e && (!best || x.e - x.s < best.e - best.s)) best = x;
    }
    return best?.el;
  }

  /** DOM point at source offset `off`; `end` selects the side for range ends. */
  private point(off: number, end: boolean): { node: Node; offset: number } | { before: Node } | { after: Node } | undefined {
    const t = this.texts.find((x) => (end ? x.s < off && off <= x.e : x.s <= off && off < x.e));
    const text = t?.el.firstChild;
    if (t && text) return { node: text, offset: Math.min(this.charIndex(t, off), text.textContent?.length ?? 0) };
    // inside an atomic element (formula, inline code without its own text span, diagram)
    const el = this.elementFor(end ? off - 1 : off, end ? off : off + 1);
    if (el && !el.classList.contains("mdr-t")) return end ? { after: el } : { before: el };
    // between texts: snap to the nearest text in the right direction
    if (end) {
      const prev = [...this.texts].reverse().find((x) => x.e <= off);
      return prev?.el.firstChild ? { node: prev.el.firstChild, offset: prev.el.firstChild.textContent?.length ?? 0 } : undefined;
    }
    const next = this.texts.find((x) => x.s >= off);
    return next?.el.firstChild ? { node: next.el.firstChild, offset: 0 } : undefined;
  }

  /** DOM Range covering source [s, e), or null if nothing rendered there. */
  range(s: number, e: number): Range | null {
    const a = this.point(s, false);
    const b = this.point(e, true);
    if (!a || !b) return null;
    const doc = (this.texts[0] ?? this.elements[0])?.el.ownerDocument;
    if (!doc) return null;
    const r = doc.createRange();
    try {
      if ("node" in a) r.setStart(a.node, a.offset);
      else if ("before" in a) r.setStartBefore(a.before);
      if ("node" in b) r.setEnd(b.node, b.offset);
      else if ("after" in b) r.setEndAfter(b.after);
    } catch {
      return null;
    }
    return r.collapsed && s < e ? null : r;
  }

  /** Source offset for a DOM point (e.g. from caretRangeFromPoint). */
  offsetAt(node: Node, offset: number): number | undefined {
    const host = (node.nodeType === 3 ? node.parentElement : (node as Element)) as HTMLElement | null;
    const t = host?.closest<HTMLElement>(".mdr-t");
    if (t && node.nodeType === 3) {
      const entry = this.texts.find((x) => x.el === t);
      if (entry) {
        const len = t.textContent?.length ?? 0;
        const span = entry.e - entry.s;
        return entry.s + (span === len ? offset : Math.round((offset * span) / Math.max(len, 1)));
      }
    }
    const el = host?.closest<HTMLElement>("[data-s]");
    return el ? Number(el.dataset.s) : undefined;
  }
}
