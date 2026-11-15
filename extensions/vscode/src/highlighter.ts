// Paints block / sentence / word highlights on every editor showing the document
// being read, and keeps the reading position in view.
import * as vscode from "vscode";
import type { SessionUpdate } from "./session.js";

type Offsets = [number, number];

export interface HighlightState {
  block?: Offsets;
  sentence?: Offsets;
  word?: Offsets;
}

export class Highlighter implements vscode.Disposable {
  private block = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("mdReader.blockHighlightBackground"),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private sentence = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("mdReader.sentenceHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("mdReader.wordHighlightBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private word = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("mdReader.wordHighlightBackground"),
    borderRadius: "3px",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  /** Last painted offsets (exposed for tests). */
  state: HighlightState = {};
  /** false after the user scrolls the reading position out of view. */
  following = true;
  private uri: vscode.Uri | undefined;
  private programmaticUntil = 0;
  private lastRevealKey = "";
  private disposables: vscode.Disposable[] = [];
  private readonly onFollowingChanged = new vscode.EventEmitter<boolean>();
  readonly onDidChangeFollowing = this.onFollowingChanged.event;

  constructor(private config: () => { words: boolean; autoScroll: boolean }) {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.onScroll(e)),
    );
  }

  setDocument(uri: vscode.Uri | undefined): void {
    if (this.uri && uri?.toString() !== this.uri.toString()) this.clear();
    this.uri = uri;
    this.setFollowing(true);
  }

  update(u: SessionUpdate): void {
    const seg = u.segment;
    if (u.state === "idle" || !seg) {
      this.clear();
      return;
    }
    const w = u.word >= 0 ? seg.words[u.word] : undefined;
    this.state = {
      block: seg.blockRange,
      sentence: seg.srcRange,
      word: w && this.config().words ? [w.srcStart, w.srcEnd] : undefined,
    };
    this.paint();
    this.reveal();
  }

  clear(): void {
    this.state = {};
    for (const e of this.editors()) {
      e.setDecorations(this.block, []);
      e.setDecorations(this.sentence, []);
      e.setDecorations(this.word, []);
    }
    this.lastRevealKey = "";
  }

  /** Scroll back to the reading position and resume following. */
  follow(): void {
    this.setFollowing(true);
    this.lastRevealKey = "";
    this.reveal(true);
  }

  private editors(): readonly vscode.TextEditor[] {
    if (!this.uri) return [];
    const key = this.uri.toString();
    return vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key);
  }

  private range(doc: vscode.TextDocument, o: Offsets | undefined): vscode.Range[] {
    if (!o) return [];
    const len = doc.getText().length;
    return [new vscode.Range(doc.positionAt(Math.min(o[0], len)), doc.positionAt(Math.min(o[1], len)))];
  }

  private paint(): void {
    for (const e of this.editors()) {
      const d = e.document;
      e.setDecorations(this.block, this.range(d, this.state.block));
      e.setDecorations(this.sentence, this.range(d, this.state.sentence));
      e.setDecorations(this.word, this.range(d, this.state.word));
    }
  }

  private target(doc: vscode.TextDocument): vscode.Range | undefined {
    const o = this.state.word ?? this.state.sentence;
    return o ? this.range(doc, o)[0] : undefined;
  }

  private reveal(force = false): void {
    if (!this.config().autoScroll || (!this.following && !force)) return;
    for (const e of this.editors()) {
      const r = this.target(e.document);
      if (!r) continue;
      const key = `${r.start.line}`;
      const visible = e.visibleRanges.some((v) => v.contains(r));
      if (visible && !force) continue;
      if (key === this.lastRevealKey && !force) continue;
      this.lastRevealKey = key;
      this.programmaticUntil = Date.now() + 500;
      e.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  private onScroll(e: vscode.TextEditorVisibleRangesChangeEvent): void {
    if (!this.uri || e.textEditor.document.uri.toString() !== this.uri.toString()) return;
    if (Date.now() < this.programmaticUntil) return;
    const r = this.target(e.textEditor.document);
    if (!r) return;
    const visible = e.visibleRanges.some((v) => v.contains(r));
    // scrolled away → stop following; scrolled back → follow again
    this.setFollowing(visible);
  }

  private setFollowing(v: boolean): void {
    if (v === this.following) return;
    this.following = v;
    this.onFollowingChanged.fire(v);
  }

  dispose(): void {
    this.clear();
    this.block.dispose();
    this.sentence.dispose();
    this.word.dispose();
    this.onFollowingChanged.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
