// Connects VS Code (editors, commands, settings) to the reading session and engine.
import * as path from "node:path";
import * as vscode from "vscode";
import { buildSpeechScript, DEFAULT_OPTIONS, segmentAtOffset, STARTER_PRONUNCIATIONS, type ReaderOptionsInput, type SpeechScript } from "@spokedown/core";
import { BUILTIN_MODELS, type Engine, type ModelConfig } from "@spokedown/engine";
import { Highlighter } from "./highlighter.js";
import { ReadingSession, type AudioSink, type SessionUpdate } from "./session.js";
import { PlayerSink, SilentSink } from "./sinks.js";
import { StatusBar } from "./statusBar.js";
import { shiftScript } from "./shift.js";
import { startPointAtOffset, startPointForLine, type StartPoint } from "./startPoint.js";
import { PreviewManager } from "./preview.js";

/** Pause settings → the reader's pause table: sentence gap in ms, and a multiplier for paragraph/heading/block pauses. */
function pausesFromConfig(c: vscode.WorkspaceConfiguration) {
  const base = DEFAULT_OPTIONS.pauses;
  const scale = Math.max(0, Math.min(3, c.get<number>("pause.blockScale", 1)));
  const ms = (v: number) => Math.round(v * scale);
  return {
    sentence: Math.max(0, Math.min(1500, c.get<number>("pause.sentenceMs", base.sentence))),
    heading: ms(base.heading),
    afterHeading: ms(base.afterHeading),
    paragraph: ms(base.paragraph),
    block: ms(base.block),
    thematicBreak: ms(base.thematicBreak),
  };
}

const SPEEDS = [0.75, 0.85, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2];

export function readConfig() {
  const c = vscode.workspace.getConfiguration("spokedown");
  return {
    model: c.get<string>("model", "kokoro"),
    voice: c.get<string>("voice", ""),
    speed: Math.max(0.5, Math.min(2, c.get<number>("speed", 1))),
    models: c.get<ModelConfig[]>("models", []),
    prefetch: c.get<number>("prefetch", 3),
    words: c.get<boolean>("highlight.words", true),
    leadMs: c.get<number>("highlight.leadMs", 60),
    autoScroll: c.get<boolean>("autoScroll", true),
    audioOutput: c.get<"auto" | "afplay" | "silent">("audioOutput", "auto"), // "afplay" is the pre-0.2 spelling of "auto"
    latencyMs: c.get<number>("audioLatencyMs", 90),
    reading: {
      code: c.get<"announce" | "read" | "skip">("reading.code", "announce"),
      codeReadMaxLines: c.get<number>("reading.codeMaxLines", 20),
      tables: c.get<"rows" | "announce" | "skip">("reading.tables", "rows"),
      mathDisplay: c.get<"short" | "full" | "announce">("reading.mathDisplay", "short"),
      mermaid: c.get<"announce" | "skip">("reading.mermaid", "announce"),
      dataBlocks: c.get<"announce" | "skip">("reading.dataBlocks", "announce"),
      frontmatter: c.get<"skip" | "announce">("reading.frontmatter", "skip"),
      maxDigits: c.get<number>("reading.numberDigits", 4),
      // the optional starter list first, so the user's own entries override it
      pauses: pausesFromConfig(c),
      pronunciations: { ...(c.get<boolean>("starterPronunciations", false) ? STARTER_PRONUNCIATIONS : {}), ...c.get<Record<string, string>>("pronunciations", {}) },
    },
  };
}

export class Controller implements vscode.Disposable {
  session: ReadingSession | undefined;
  script: SpeechScript | undefined;
  uri: vscode.Uri | undefined;
  readonly highlighter: Highlighter;
  readonly previews: PreviewManager;
  private status = new StatusBar();
  private sink: AudioSink | undefined;
  private sinkKind = "";
  private prepared = new Set<string>();
  private last: SessionUpdate | undefined;
  private disposables: vscode.Disposable[] = [];
  private readonly updates = new vscode.EventEmitter<SessionUpdate>();
  /** Fires on every session update (used by tests). */
  readonly onDidUpdate = this.updates.event;

  constructor(private engine: Engine, extensionUri: vscode.Uri) {
    this.highlighter = new Highlighter(() => readConfig());
    this.previews = new PreviewManager(extensionUri, {
      click: (uri, offset) => void this.previewClick(uri, offset),
      command: (name) => void vscode.commands.executeCommand(`spokedown.${name}`),
    });
    this.disposables.push(
      this.previews,
      this.highlighter,
      this.status,
      this.updates,
      this.highlighter.onDidChangeFollowing((v) => this.status.following(v, this.isActive())),
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (this.uri && d.uri.toString() === this.uri.toString()) this.stop();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshIdleStatus()),
    );
    this.refreshIdleStatus();
  }

  // ---------- commands ----------

  /** Read from the cursor line (editor) or from the marked word (read-along preview). */
  async readFromCursor(): Promise<void> {
    const t = await this.target();
    if (!t) return;
    if (t.editor) await this.read(t.doc, { line: t.editor.selection.active.line });
    else await this.read(t.doc, { word: this.previews.marker(t.doc.uri).offset ?? 0 });
  }

  async readFile(): Promise<void> {
    const t = await this.target();
    if (t) await this.read(t.doc, { offset: 0 });
  }

  async readSelection(): Promise<void> {
    const t = await this.target();
    if (!t) return;
    const ed = t.editor;
    if (!ed || ed.selection.isEmpty) return this.readFromCursor();
    await this.read(t.doc, { offset: ed.document.offsetAt(ed.selection.start) }, ed.document.offsetAt(ed.selection.end));
  }

  async openPreview(): Promise<void> {
    const t = await this.target();
    if (t) await this.previews.open(t.doc);
  }

  /** A word was clicked in the preview: mark it; while reading, jump there. */
  private async previewClick(uri: vscode.Uri, offset: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const same = !!this.uri && this.uri.toString() === uri.toString();
    const script = same && this.script ? this.script : await buildSpeechScript(doc.getText(), this.readerOptions(doc));
    const sp = startPointAtOffset(script, offset);
    const w = script.segments[sp.index]?.words[sp.word];
    this.previews.setMarker(uri, offset, w ? [w.srcStart, w.srcEnd] : undefined);
    if (same && this.session && this.last && this.last.state !== "idle") {
      this.pausedCursorLine = undefined;
      this.session.start(sp.index, sp.word);
    }
  }

  async toggle(): Promise<void> {
    if (this.session && this.last && this.last.state === "paused" && (this.cursorMovedSincePause() || this.markerMovedSincePause())) {
      await this.readFromCursor(); // the user put the cursor somewhere new: read from there
      return;
    }
    if (this.session && this.last && this.last.state !== "idle") this.session.toggle();
    else await this.readFromCursor();
  }

  pause(): void {
    this.session?.pause();
  }

  /** Cursor line in the reading document when playback was last paused. */
  private pausedCursorLine: number | undefined;

  private pausedMarkerVersion = 0;

  private markerMovedSincePause(): boolean {
    const uri = this.previews.activeUri();
    return !!uri && !!this.uri && uri.toString() === this.uri.toString() && this.previews.marker(uri).version !== this.pausedMarkerVersion;
  }

  private cursorMovedSincePause(): boolean {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !this.uri || ed.document.uri.toString() !== this.uri.toString()) return false;
    return this.pausedCursorLine !== undefined && ed.selection.active.line !== this.pausedCursorLine;
  }

  resume(): void {
    this.session?.resume();
  }

  stop(): void {
    this.session?.stop();
    this.session = undefined;
    this.highlighter.clear();
    this.previews.clearAll(readConfig().speed);
    void vscode.commands.executeCommand("setContext", "spokedown.active", false);
    this.refreshIdleStatus();
  }

  nav(action: "nextSentence" | "previousSentence" | "nextHeading" | "previousHeading" | "skipBlock"): void {
    this.session?.[action]();
  }

  async changeSpeed(delta: number): Promise<void> {
    const s = Math.round(Math.max(0.5, Math.min(2, readConfig().speed + delta)) * 100) / 100;
    await vscode.workspace.getConfiguration("spokedown").update("speed", s, vscode.ConfigurationTarget.Global);
  }

  async setSpeed(): Promise<void> {
    const cur = readConfig().speed;
    const pick = await vscode.window.showQuickPick(
      SPEEDS.map((s) => ({ label: `${s}×`, description: s === cur ? "current" : s === 1 ? "normal" : undefined, s })),
      { title: "Reading speed" },
    );
    if (pick) await vscode.workspace.getConfiguration("spokedown").update("speed", pick.s, vscode.ConfigurationTarget.Global);
  }

  async selectModel(): Promise<void> {
    const cfg = readConfig();
    const items = this.engine.models().filter((m) => m.type !== "say" || process.platform === "darwin").map((m) => {
      const builtin = BUILTIN_MODELS.find((b) => b.config.id === m.id);
      return {
        label: m.label ?? m.id,
        description: `${m.id}${m.id === cfg.model ? " · current" : ""}`,
        detail: builtin ? `${builtin.description}${builtin.sizeMB ? ` (${builtin.sizeMB} MB)` : ""}` : m.type === "openai" ? `${m.model} @ ${m.baseUrl}` : undefined,
        id: m.id,
      };
    });
    const pick = await vscode.window.showQuickPick(items, { title: "Reading model", matchOnDetail: true });
    if (!pick || pick.id === cfg.model) return;
    const conf = vscode.workspace.getConfiguration("spokedown");
    await conf.update("model", pick.id, vscode.ConfigurationTarget.Global);
    await conf.update("voice", "", vscode.ConfigurationTarget.Global); // voices differ per model
  }

  /** Respell the word under the cursor (or the selection) in the pronunciation dictionary. */
  async addPronunciation(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    let word = "";
    if (ed) {
      const range = ed.selection.isEmpty ? ed.document.getWordRangeAtPosition(ed.selection.active, /[A-Za-z0-9][A-Za-z0-9_.+#-]*/) : ed.selection;
      word = range ? ed.document.getText(range).trim() : "";
    }
    word = (await vscode.window.showInputBox({ title: "Spokedown: word to respell", value: word, prompt: "The word or phrase as written (lowercase ignores case)", validateInput: (v) => (v.trim() ? undefined : "Enter a word") }))?.trim() ?? "";
    if (!word) return;
    // Plain lowercase words match any capitalisation; acronyms and CamelCase keep their exact spelling.
    const key = /[A-Z]/.test(word.slice(1)) || /\s/.test(word) ? word : word.toLowerCase();

    const conf = vscode.workspace.getConfiguration("spokedown");
    const existing = { ...(conf.inspect<Record<string, string>>("pronunciations")?.globalValue ?? {}) };
    const spoken = await vscode.window.showInputBox({
      title: `Spokedown: how should "${key}" sound?`,
      value: existing[key] ?? "",
      prompt: 'Spell it the way it should be said, e.g. "kube control". Leave empty to remove the entry.',
    });
    if (spoken === undefined) return;
    if (spoken.trim()) existing[key] = spoken.trim();
    else delete existing[key];
    await conf.update("pronunciations", existing, vscode.ConfigurationTarget.Global);
    if (!spoken.trim()) return void vscode.window.showInformationMessage(`Spokedown: removed the pronunciation for "${key}".`);
    const hear = "Read from cursor";
    const pick = await vscode.window.showInformationMessage(`Spokedown: "${key}" will be read as "${spoken.trim()}".`, hear);
    if (pick === hear) await this.readFromCursor();
  }

  async selectVoice(): Promise<void> {
    const cfg = readConfig();
    try {
      await this.ensureModel(cfg.model);
      const backend = this.engine.backend(cfg.model);
      const voices = await backend.voices();
      const current = cfg.voice || backend.defaultVoice();
      const items = voices
        .sort((a, b) => (b.grade ?? "").localeCompare(a.grade ?? "") * -1 || a.language.localeCompare(b.language) || a.name.localeCompare(b.name))
        .map((v) => ({
          label: v.name,
          description: [v.id !== v.name ? v.id : "", v.language, v.gender, v.grade ? `grade ${v.grade}` : "", v.id === current ? "current" : ""].filter(Boolean).join(" · "),
          id: v.id,
        }));
      const pick = await vscode.window.showQuickPick(items, { title: `Voice (${backend.label})`, matchOnDescription: true });
      if (pick) await vscode.workspace.getConfiguration("spokedown").update("voice", pick.id, vscode.ConfigurationTarget.Global);
    } catch (e) {
      this.showError(e);
    }
  }

  /** Warm up the model in the background (no UI, errors ignored until the user reads). */
  preload(): void {
    const cfg = readConfig();
    if (!vscode.workspace.getConfiguration("spokedown").get<boolean>("preloadModel", true)) return;
    if (this.prepared.has(cfg.model)) return;
    void this.engine.prepare(cfg.model).then(
      () => this.prepared.add(cfg.model),
      () => undefined,
    );
  }

  follow(): void {
    this.highlighter.follow();
  }

  async showScript(): Promise<void> {
    const t = await this.target();
    if (!t) return;
    const src = t.doc.getText();
    const script = await buildSpeechScript(src, this.readerOptions(t.doc));
    const lines = script.segments.map((s) => {
      const line = t.doc.positionAt(s.srcRange[0]).line + 1;
      return `L${line}\t${s.kind}${s.mode === "announce" ? " »" : ""}\t${s.text}`;
    });
    const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n") + "\n", language: "plaintext" });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  async clearCache(): Promise<void> {
    await this.engine.cache.clear();
    void vscode.window.showInformationMessage("Spokedown: audio cache cleared.");
  }

  /** Settings changed. */
  onConfigChanged(e: vscode.ConfigurationChangeEvent): void {
    const cfg = readConfig();
    if (e.affectsConfiguration("spokedown.models")) this.engine.setModels(cfg.models);
    if (e.affectsConfiguration("spokedown.audioOutput")) this.sinkKind = "";
    if (["model", "voice", "speed", "models"].some((k) => e.affectsConfiguration(`spokedown.${k}`))) this.session?.invalidateUpcoming();
    if ((e.affectsConfiguration("spokedown.reading") || e.affectsConfiguration("spokedown.pronunciations") || e.affectsConfiguration("spokedown.starterPronunciations") || e.affectsConfiguration("spokedown.pause")) && this.session && this.uri) void this.rebuild();
    if (this.last && this.script) this.status.update(this.last, this.script.segments, cfg.speed, this.modelLabel());
  }

  // ---------- internals ----------

  private isActive(): boolean {
    return !!this.session && !!this.last && this.last.state !== "idle";
  }

  /** The Markdown document to act on: the active editor, else the focused read-along preview. */
  private async target(): Promise<{ doc: vscode.TextDocument; editor?: vscode.TextEditor } | undefined> {
    const ed = vscode.window.activeTextEditor;
    const previewUri = this.previews.activeUri();
    if (previewUri) return { doc: await vscode.workspace.openTextDocument(previewUri) };
    if (ed && (ed.document.languageId === "markdown" || /\.(md|markdown|mdx)$/i.test(ed.document.fileName))) return { doc: ed.document, editor: ed };
    void vscode.window.showInformationMessage("Spokedown: open a Markdown file first.");
    return undefined;
  }

  private readerOptions(doc: vscode.TextDocument): ReaderOptionsInput {
    const r = readConfig().reading;
    return { ...r, fileName: path.basename(doc.fileName) };
  }

  private modelLabel(): string {
    const id = readConfig().model;
    return this.engine.models().find((m) => m.id === id)?.label ?? id;
  }

  private getSink(): AudioSink {
    const kind = readConfig().audioOutput === "silent" ? "silent" : "player";
    if (!this.sink || kind !== this.sinkKind) {
      this.sink?.dispose?.();
      this.sink = kind === "player" ? new PlayerSink(() => readConfig().latencyMs / 1000) : new SilentSink();
      this.sinkKind = kind;
      if (kind === "player" && vscode.env.remoteName) {
        void vscode.window.showWarningMessage(
          `Spokedown plays sound on the machine where the extension runs, and this window is remote (${vscode.env.remoteName}), which usually has no audio device. Open the folder locally to hear it.`,
        );
      }
    }
    return this.sink;
  }

  private async ensureModel(modelId: string): Promise<void> {
    if (this.prepared.has(modelId)) return;
    const label = this.engine.models().find((m) => m.id === modelId)?.label ?? modelId;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Spokedown: loading ${label}` }, (p) =>
      this.engine.prepare(modelId, (e) => {
        if (e.status === "progress" && e.file && (e.total ?? 0) > 5_000_000) p.report({ message: `downloading ${path.basename(e.file)} ${Math.round(e.progress ?? 0)}%` });
      }),
    );
    this.prepared.add(modelId);
  }

  private async read(doc: vscode.TextDocument, from: { line: number } | { offset: number } | { word: number }, to?: number): Promise<void> {
    this.session?.stop();
    try {
      const script = await buildSpeechScript(doc.getText(), this.readerOptions(doc));
      if (!script.segments.length) {
        void vscode.window.showInformationMessage("Spokedown: nothing to read here.");
        return;
      }
      let sp: StartPoint;
      if ("line" in from) {
        const line = doc.lineAt(from.line);
        sp = startPointForLine(script, doc.offsetAt(line.range.start), doc.offsetAt(line.rangeIncludingLineBreak.end));
      } else if ("word" in from) sp = startPointAtOffset(script, from.word);
      else sp = { index: segmentAtOffset(script, from.offset)?.id ?? 0, word: 0 };
      const end = to === undefined ? script.segments.length : Math.max(sp.index + 1, script.segments.findIndex((s) => s.srcRange[0] >= to) >>> 0);
      this.script = script;
      this.uri = doc.uri;
      this.pausedCursorLine = undefined;
      this.highlighter.setDocument(doc.uri);
      this.startSession(script, sp.index, Math.min(end, script.segments.length), sp.word);
      if (vscode.workspace.getConfiguration("spokedown").get<boolean>("preview.openOnRead", false) && !this.previews.hasPreview(doc.uri)) {
        await this.previews.open(doc);
      }
      void vscode.commands.executeCommand("setContext", "spokedown.active", true);
    } catch (e) {
      this.showError(e);
    }
  }

  private startSession(script: SpeechScript, from: number, to: number, word = 0): void {
    const session = new ReadingSession(
      script,
      {
        synth: async (seg, signal) => {
          const cfg = readConfig();
          await this.ensureModel(cfg.model);
          return this.engine.synthesizeSegment(seg, { modelId: cfg.model, voice: cfg.voice, speed: cfg.speed }, signal);
        },
        sink: this.getSink(),
        onUpdate: (u) => this.onUpdate(session, u),
        onError: (e) => this.showError(e),
        prefetch: () => readConfig().prefetch,
        leadSec: () => readConfig().leadMs / 1000,
      },
      { from, to },
    );
    this.session = session;
    session.start(from, word);
  }

  /** Reading options changed mid-session: rebuild and continue from the same place. */
  private async rebuild(): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri?.toString());
    const cur = this.last?.segment;
    if (!doc || !cur || !this.session) return;
    const wasPaused = this.last?.state === "paused";
    this.session.stop();
    const script = await buildSpeechScript(doc.getText(), this.readerOptions(doc));
    this.script = script;
    const start = segmentAtOffset(script, cur.srcRange[0])?.id ?? 0;
    this.startSession(script, start, script.segments.length);
    if (wasPaused) this.session?.pause();
  }

  private onUpdate(session: ReadingSession, u: SessionUpdate): void {
    if (session !== this.session) return; // a replaced session finishing up
    if (u.state === "paused" && this.last?.state !== "paused") {
      const ed = vscode.window.activeTextEditor;
      this.pausedCursorLine = ed && ed.document.uri.toString() === this.uri?.toString() ? ed.selection.active.line : undefined;
      if (this.uri) this.pausedMarkerVersion = this.previews.marker(this.uri).version;
    }
    this.last = u;
    this.highlighter.update(u);
    this.previews.highlight(this.uri, this.highlighter.state);
    this.previews.status(this.uri, u.state, readConfig().speed, this.modelLabel());
    if (u.state === "idle") {
      if (u.finished) this.stop();
      else this.refreshIdleStatus();
    } else {
      this.status.update(u, session.segments, readConfig().speed, this.modelLabel());
    }
    this.updates.fire(u);
  }

  private onEdit(e: vscode.TextDocumentChangeEvent): void {
    if (!this.script || !this.uri || e.document.uri.toString() !== this.uri.toString() || !e.contentChanges.length) return;
    shiftScript(this.script, e.contentChanges);
    if (this.session) this.highlighter.update(this.session.snapshot());
  }

  private refreshIdleStatus(): void {
    if (this.isActive()) return;
    const doc = vscode.window.activeTextEditor?.document;
    this.status.idle(!!doc && doc.languageId === "markdown");
  }

  private showError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(msg)) return;
    const useSystem = "Use macOS voice";
    const offerSystem = process.platform === "darwin" && readConfig().model !== "system";
    void vscode.window.showErrorMessage(`Spokedown: ${msg}`, ...(offerSystem ? [useSystem] : [])).then(async (a) => {
      if (a === useSystem) await vscode.workspace.getConfiguration("spokedown").update("model", "system", vscode.ConfigurationTarget.Global);
    });
  }

  dispose(): void {
    this.stop();
    this.sink?.dispose?.();
    for (const d of this.disposables) d.dispose();
  }
}
