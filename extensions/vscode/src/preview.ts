// Read-along preview panels: VS Code's own preview can't be driven by other
// extensions, so this panel renders the Markdown itself (same look via VS Code's
// markdown.css) and receives live highlights.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { HighlightState } from "./highlighter.js";
import { renderPreviewHtml } from "./previewRender.js";
import type { PlayState } from "./session.js";

export const PREVIEW_VIEW_TYPE = "spokedown.preview";

export interface PreviewHandlers {
  /** A word was clicked at this source offset. */
  click(uri: vscode.Uri, offset: number): void;
  command(name: string): void;
}

interface Painted {
  word: string | null;
  sentence: string | null;
  block: string | null;
}

class Panel {
  ready = false;
  marker: number | undefined;
  /** Bumped each time the marker moves (lets the controller notice a new spot). */
  markerVersion = 0;
  lastPainted: Painted | undefined;
  private pending: unknown[] = [];
  private renderTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly panel: vscode.WebviewPanel, public uri: vscode.Uri) {}

  post(msg: unknown): void {
    if (this.ready) void this.panel.webview.postMessage(msg);
    else this.pending.push(msg);
  }

  flush(): void {
    this.ready = true;
    for (const m of this.pending) void this.panel.webview.postMessage(m);
    this.pending = [];
  }

  scheduleRender(fn: () => void, ms: number): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(fn, ms);
  }
}

export class PreviewManager implements vscode.Disposable {
  private panels = new Map<string, Panel>();
  private disposables: vscode.Disposable[] = [];
  private readonly painted = new vscode.EventEmitter<{ uri: vscode.Uri; painted: Painted }>();
  /** Fires when a preview has drawn a highlight (used by tests). */
  readonly onDidPaint = this.painted.event;

  constructor(private extensionUri: vscode.Uri, private handlers: PreviewHandlers) {
    this.disposables.push(
      this.painted,
      vscode.workspace.onDidChangeTextDocument((e) => {
        const p = this.panels.get(e.document.uri.toString());
        if (p) p.scheduleRender(() => this.render(p), 250);
      }),
    );
  }

  /** Open (or reveal) the preview for a document beside the editor. */
  async open(doc: vscode.TextDocument, column = vscode.ViewColumn.Beside): Promise<void> {
    const key = doc.uri.toString();
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(undefined, true);
      return;
    }
    const roots = this.resourceRoots(doc.uri);
    const panel = vscode.window.createWebviewPanel(
      PREVIEW_VIEW_TYPE,
      `Read Aloud: ${path.basename(doc.fileName)}`,
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg");
    const p = new Panel(panel, doc.uri);
    this.panels.set(key, p);
    panel.webview.html = this.shell(panel.webview);
    panel.onDidDispose(() => this.panels.delete(key), null, this.disposables);
    panel.webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => this.onMessage(p, m), null, this.disposables);
    this.render(p);
  }

  /** The document whose preview is focused, if any. */
  activeUri(): vscode.Uri | undefined {
    for (const p of this.panels.values()) if (p.panel.active) return p.uri;
    return undefined;
  }

  hasPreview(uri: vscode.Uri): boolean {
    return this.panels.has(uri.toString());
  }

  marker(uri: vscode.Uri): { offset: number | undefined; version: number } {
    const p = this.panels.get(uri.toString());
    return { offset: p?.marker, version: p?.markerVersion ?? 0 };
  }

  lastPainted(uri: vscode.Uri): Painted | undefined {
    return this.panels.get(uri.toString())?.lastPainted;
  }

  highlight(uri: vscode.Uri | undefined, h: HighlightState): void {
    if (!uri) return;
    this.panels.get(uri.toString())?.post({ type: "highlight", block: h.block, sentence: h.sentence, word: h.word });
  }

  status(uri: vscode.Uri | undefined, state: PlayState, speed: number, label: string): void {
    if (!uri) return;
    this.panels.get(uri.toString())?.post({ type: "status", state, speed, label });
  }

  /** Clear highlights in every preview (reading stopped). */
  clearAll(speed: number): void {
    for (const p of this.panels.values()) {
      p.post({ type: "highlight" });
      p.post({ type: "status", state: "idle", speed, label: "" });
    }
  }

  setMarker(uri: vscode.Uri, offset: number, range: [number, number] | undefined): void {
    const p = this.panels.get(uri.toString());
    if (!p) return;
    p.marker = offset;
    p.markerVersion++;
    p.post({ type: "marker", range });
  }

  private onMessage(p: Panel, m: { type: string; [k: string]: unknown }): void {
    switch (m.type) {
      case "ready":
        p.flush();
        break;
      case "click":
        if (typeof m.offset === "number") this.handlers.click(p.uri, m.offset);
        break;
      case "command":
        if (typeof m.command === "string") this.handlers.command(m.command);
        break;
      case "painted":
        p.lastPainted = { word: m.word as string | null, sentence: m.sentence as string | null, block: m.block as string | null };
        this.painted.fire({ uri: p.uri, painted: p.lastPainted });
        break;
      case "link":
        void this.openLink(p.uri, String(m.href ?? ""));
        break;
    }
  }

  private async openLink(docUri: vscode.Uri, href: string): Promise<void> {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const [file, frag] = href.split("#");
    const target = file ? vscode.Uri.joinPath(docUri, "..", decodeURIComponent(file)) : docUri;
    const line = frag && /^L\d+/.test(frag) ? Number(frag.slice(1)) - 1 : undefined;
    const doc = await vscode.workspace.openTextDocument(target);
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
    if (line !== undefined) {
      const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private render(p: Panel): void {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === p.uri.toString());
    if (!doc) return;
    const dir = path.dirname(doc.fileName);
    let html: string;
    try {
      html = renderPreviewHtml(doc.getText(), {
        resolveImage: (src) => {
          if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return undefined;
          return p.panel.webview.asWebviewUri(vscode.Uri.file(path.resolve(dir, decodeURIComponent(src)))).toString();
        },
      });
    } catch (e) {
      html = `<p><strong>Preview failed:</strong> ${String(e instanceof Error ? e.message : e).replace(/</g, "&lt;")}</p>`;
    }
    p.post({ type: "render", html });
  }

  private assetRoots(): { media: vscode.Uri; dist: vscode.Uri; katex: vscode.Uri; mermaid: vscode.Uri; vscodeMedia: vscode.Uri } {
    const real = (u: vscode.Uri) => {
      try {
        return vscode.Uri.file(fs.realpathSync(u.fsPath));
      } catch {
        return u;
      }
    };
    return {
      media: vscode.Uri.joinPath(this.extensionUri, "media"),
      dist: vscode.Uri.joinPath(this.extensionUri, "dist"),
      katex: real(vscode.Uri.joinPath(this.extensionUri, "node_modules", "katex", "dist")),
      mermaid: real(vscode.Uri.joinPath(this.extensionUri, "node_modules", "mermaid", "dist")),
      vscodeMedia: vscode.Uri.file(path.join(vscode.env.appRoot, "extensions", "markdown-language-features", "media")),
    };
  }

  private resourceRoots(docUri: vscode.Uri): vscode.Uri[] {
    const a = this.assetRoots();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
    return [a.media, a.dist, a.katex, a.mermaid, a.vscodeMedia, vscode.Uri.joinPath(docUri, ".."), ...folders];
  }

  private shell(webview: vscode.Webview): string {
    const a = this.assetRoots();
    const u = (base: vscode.Uri, ...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(base, ...p)).toString();
    const nonce = crypto.randomBytes(16).toString("base64");
    const md = vscode.workspace.getConfiguration("markdown.preview");
    const fontFamily = md.get<string>("fontFamily") ?? "";
    const fontSize = md.get<number>("fontSize") ?? 14;
    const lineHeight = md.get<number>("lineHeight") ?? 1.6;
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${u(a.vscodeMedia, "markdown.css")}">
<link rel="stylesheet" href="${u(a.vscodeMedia, "highlight.css")}">
<link rel="stylesheet" href="${u(a.katex, "katex.min.css")}">
<link rel="stylesheet" href="${u(a.media, "preview.css")}">
<style>body { ${fontFamily ? `font-family: ${fontFamily};` : ""} font-size: ${fontSize}px; line-height: ${lineHeight}; }</style>
</head>
<body class="vscode-body">
<div id="toolbar">
  <button id="prev" title="Previous sentence"></button>
  <button id="play" title="Play"></button>
  <button id="next" title="Next sentence"></button>
  <button id="stop" title="Stop"></button>
  <button id="speed" title="Reading speed">1×</button>
  <span id="state"></span>
</div>
<div id="content" class="markdown-body"></div>
<button id="back" hidden>Back to reading</button>
<script nonce="${nonce}" src="${u(a.mermaid, "mermaid.min.js")}"></script>
<script nonce="${nonce}" src="${u(a.dist, "preview.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const p of this.panels.values()) p.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
