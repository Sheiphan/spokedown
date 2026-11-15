// Read-along preview (runs inside the webview).
import { SourceMap } from "./sourceMap.js";

type Offsets = [number, number];
interface HighlightMsg {
  type: "highlight";
  block?: Offsets;
  sentence?: Offsets;
  word?: Offsets;
}
interface StatusMsg {
  type: "status";
  state: "idle" | "loading" | "playing" | "paused";
  speed: number;
  label: string;
}
type InMsg = { type: "render"; html: string } | HighlightMsg | StatusMsg | { type: "marker"; range?: Offsets };

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
declare const mermaid: { initialize(c: object): void; run(o: { nodes: Element[] }): Promise<void> } | undefined;
declare const CSS: { highlights?: Map<string, unknown> };
declare const Highlight: new (...r: Range[]) => unknown;

const vscode = acquireVsCodeApi();
const content = document.getElementById("content")!;
const back = document.getElementById("back")!;
const playBtn = document.getElementById("play")!;
const speedBtn = document.getElementById("speed")!;
const stateLabel = document.getElementById("state")!;

let map = new SourceMap(content);
let last: HighlightMsg | undefined;
let marker: Offsets | undefined;
let blockEl: HTMLElement | undefined;
let following = true;
let reading = false;
let programmaticUntil = 0;
let lastPainted = "";

const setHighlight = (name: string, r: Range | null) => {
  if (!CSS.highlights) return;
  if (r) CSS.highlights.set(name, new Highlight(r));
  else CSS.highlights.delete(name);
};

function targetRange(): Range | null {
  if (!last) return null;
  const o = last.word ?? last.sentence;
  return o ? map.range(o[0], o[1]) : null;
}

function isVisible(r: Range): boolean {
  const rect = r.getBoundingClientRect();
  return rect.bottom > 40 && rect.top < window.innerHeight - 40;
}

function setFollowing(v: boolean) {
  following = v;
  back.hidden = v || !reading;
}

function paint() {
  const h = last;
  const sentence = h?.sentence ? map.range(h.sentence[0], h.sentence[1]) : null;
  const word = h?.word ? map.range(h.word[0], h.word[1]) : null;
  setHighlight("mdr-sentence", sentence);
  setHighlight("mdr-word", word);
  const block = h?.block ? map.elementFor(h.block[0], h.block[1]) : undefined;
  if (block !== blockEl) {
    blockEl?.classList.remove("mdr-block");
    block?.classList.add("mdr-block");
    blockEl = block;
  }
  const r = word ?? sentence;
  if (r && following && !isVisible(r)) {
    programmaticUntil = Date.now() + 700;
    const rect = r.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3, behavior: "smooth" });
  }
  const painted = `${word?.toString() ?? ""}|${sentence?.toString() ?? ""}`;
  if (painted !== lastPainted) {
    lastPainted = painted;
    vscode.postMessage({ type: "painted", word: word?.toString() ?? null, sentence: sentence?.toString() ?? null, block: block?.tagName ?? null });
  }
}

function paintMarker() {
  setHighlight("mdr-marker", marker ? map.range(marker[0], marker[1]) : null);
}

async function renderMermaid() {
  const nodes = Array.from(content.querySelectorAll("pre.mermaid"));
  if (!nodes.length || typeof mermaid === "undefined") return;
  const dark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
  try {
    await mermaid.run({ nodes });
  } catch {
    /* a broken diagram stays as text */
  }
}

window.addEventListener("message", (ev: MessageEvent<InMsg>) => {
  const m = ev.data;
  switch (m.type) {
    case "render": {
      const y = window.scrollY;
      content.innerHTML = m.html;
      map = new SourceMap(content);
      blockEl = undefined;
      lastPainted = "";
      window.scrollTo(0, y);
      paint();
      paintMarker();
      void renderMermaid().then(() => paint());
      vscode.postMessage({ type: "rendered", texts: map.texts.length });
      break;
    }
    case "highlight":
      last = m;
      if (!m.sentence && !m.word && !m.block) {
        reading = false;
        setFollowing(true);
      } else reading = true;
      paint();
      break;
    case "marker":
      marker = m.range;
      paintMarker();
      break;
    case "status": {
      reading = m.state !== "idle";
      playBtn.innerHTML = m.state === "playing" || m.state === "loading" ? ICON_PAUSE : ICON_PLAY;
      playBtn.title = m.state === "playing" ? "Pause" : "Play from the marked word (click a word to mark it)";
      speedBtn.textContent = `${m.speed}×`;
      stateLabel.textContent = m.state === "loading" ? "Preparing…" : m.state === "paused" ? "Paused" : "";
      back.hidden = following || !reading;
      break;
    }
  }
});

// Scrolling away from the reading position stops auto-follow; scrolling back resumes it.
window.addEventListener(
  "scroll",
  () => {
    if (!reading || Date.now() < programmaticUntil) return;
    const r = targetRange();
    if (r) setFollowing(isVisible(r));
  },
  { passive: true },
);

back.addEventListener("click", () => {
  setFollowing(true);
  paint();
});

// Click a word: mark it (and jump there while reading). Links open normally.
content.addEventListener("click", (ev) => {
  const a = (ev.target as Element).closest?.("a[href]");
  if (a) {
    ev.preventDefault();
    vscode.postMessage({ type: "link", href: a.getAttribute("href") });
    return;
  }
  if (String(window.getSelection() ?? "").length) return; // selecting text, not clicking
  const pos = (document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(ev.clientX, ev.clientY);
  if (!pos) return;
  const off = map.offsetAt(pos.startContainer, pos.startOffset);
  if (off === undefined) return;
  vscode.postMessage({ type: "click", offset: off });
});

for (const [id, command] of [["prev", "previousSentence"], ["next", "nextSentence"], ["stop", "stop"], ["play", "toggle"], ["speed", "setSpeed"]] as const) {
  document.getElementById(id)!.addEventListener("click", () => vscode.postMessage({ type: "command", command }));
}

const svg = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="${d}"/></svg>`;
const ICON_PLAY = svg("M4 2.5v11l9-5.5z");
const ICON_PAUSE = svg("M4 2h3v12H4zM9 2h3v12H9z");
document.getElementById("prev")!.innerHTML = svg("M3 2h2v12H3zM14 2.5v11L6 8z");
document.getElementById("next")!.innerHTML = svg("M11 2h2v12h-2zM2 2.5v11L10 8z");
document.getElementById("stop")!.innerHTML = svg("M3 3h10v10H3z");
playBtn.innerHTML = ICON_PLAY;

vscode.postMessage({ type: "ready" });
