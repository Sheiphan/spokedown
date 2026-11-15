import * as vscode from "vscode";
import type { SessionUpdate } from "./session.js";

/** Shortcut label in the platform's own notation: ⌃⌥R on macOS, Ctrl+Alt+R elsewhere. */
const key = (k: string) => (process.platform === "darwin" ? `⌃⌥${k}` : `Ctrl+Alt+${k}`);

/** Remaining reading time from word counts (≈160 wpm at 1×). */
function remaining(u: SessionUpdate, all: { words: unknown[] }[], speed: number): string {
  let words = 0;
  for (let i = u.index; i < all.length; i++) words += all[i]!.words.length;
  const min = words / (160 * speed);
  return min < 1 ? "<1 min" : `${Math.round(min)} min`;
}

export class StatusBar implements vscode.Disposable {
  private main = vscode.window.createStatusBarItem("mdReader.main", vscode.StatusBarAlignment.Right, 200);
  private speed = vscode.window.createStatusBarItem("mdReader.speed", vscode.StatusBarAlignment.Right, 199);
  private back = vscode.window.createStatusBarItem("mdReader.follow", vscode.StatusBarAlignment.Right, 198);

  constructor() {
    this.main.name = "Markdown Reader";
    this.speed.name = "Markdown Reader Speed";
    this.speed.command = "mdReader.setSpeed";
    this.back.name = "Markdown Reader: Back to Reading";
    this.back.text = "$(eye) Back to reading";
    this.back.tooltip = "Scroll to the sentence being read and follow it again";
    this.back.command = "mdReader.followReading";
  }

  /** Shown when no reading session is active. */
  idle(markdownActive: boolean): void {
    this.back.hide();
    this.speed.hide();
    if (!markdownActive) {
      this.main.hide();
      return;
    }
    this.main.text = "$(unmute) Read";
    this.main.tooltip = `Read aloud from the cursor (${key("R")})`;
    this.main.command = "mdReader.readFromCursor";
    this.main.backgroundColor = undefined;
    this.main.show();
  }

  update(u: SessionUpdate, segments: { words: unknown[] }[], speed: number, model: string): void {
    const pct = segments.length ? Math.round((u.index / segments.length) * 100) : 0;
    const left = remaining(u, segments, speed);
    this.main.command = "mdReader.toggle";
    switch (u.state) {
      case "loading":
        this.main.text = "$(loading~spin) Preparing…";
        this.main.tooltip = `Synthesizing with ${model}`;
        break;
      case "playing":
        this.main.text = `$(debug-pause) ${pct}% · ${left}`;
        this.main.tooltip = `Reading with ${model}${u.quality === "estimated" ? " (approximate word timing)" : ""}. Click to pause (${key("R")}).`;
        break;
      case "paused":
        this.main.text = `$(play) Paused · ${pct}%`;
        this.main.tooltip = `Resume (${key("R")})`;
        break;
      case "idle":
        return;
    }
    this.main.show();
    this.speed.text = `${speed.toFixed(speed % 1 ? 2 : 1).replace(/0$/, "")}×`;
    this.speed.tooltip = `Reading speed (${key("=")} faster / ${key("-")} slower)`;
    this.speed.show();
  }

  following(v: boolean, active: boolean): void {
    if (!v && active) this.back.show();
    else this.back.hide();
  }

  dispose(): void {
    this.main.dispose();
    this.speed.dispose();
    this.back.dispose();
  }
}
