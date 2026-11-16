import * as path from "node:path";
import * as vscode from "vscode";
import { Engine } from "@spokedown/engine";
import { Controller, readConfig } from "./controller.js";
import { defaultDataDir } from "./paths.js";

export interface SpokedownApi {
  controller: Controller;
  engine: Engine;
}

export function activate(context: vscode.ExtensionContext): SpokedownApi {
  const conf = vscode.workspace.getConfiguration("spokedown");
  const dataDir = conf.get<string>("dataDirectory") || defaultDataDir();
  const engine = new Engine({
    models: readConfig().models,
    modelsDir: path.join(dataDir, "models"),
    cacheDir: path.join(dataDir, "audio"),
    cacheMaxBytes: conf.get<number>("cacheSizeMB", 512) * 1024 * 1024,
  });
  const controller = new Controller(engine, context.extensionUri);

  const cmd = (id: string, fn: () => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`spokedown.${id}`, fn));
  cmd("toggle", () => controller.toggle());
  cmd("readFromCursor", () => controller.readFromCursor());
  cmd("readFile", () => controller.readFile());
  cmd("readSelection", () => controller.readSelection());
  cmd("pause", () => controller.pause());
  cmd("resume", () => controller.resume());
  cmd("stop", () => controller.stop());
  cmd("nextSentence", () => controller.nav("nextSentence"));
  cmd("previousSentence", () => controller.nav("previousSentence"));
  cmd("nextHeading", () => controller.nav("nextHeading"));
  cmd("previousHeading", () => controller.nav("previousHeading"));
  cmd("skipBlock", () => controller.nav("skipBlock"));
  cmd("faster", () => controller.changeSpeed(0.1));
  cmd("slower", () => controller.changeSpeed(-0.1));
  cmd("setSpeed", () => controller.setSpeed());
  cmd("selectVoice", () => controller.selectVoice());
  cmd("addPronunciation", () => controller.addPronunciation());
  cmd("editPronunciations", () => vscode.commands.executeCommand("workbench.action.openSettings", "spokedown.pronunciations"));
  cmd("selectModel", () => controller.selectModel());
  cmd("followReading", () => controller.follow());
  cmd("showScript", () => controller.showScript());
  cmd("clearCache", () => controller.clearCache());
  cmd("openPreview", () => controller.openPreview());

  context.subscriptions.push(
    controller,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("spokedown")) controller.onConfigChanged(e);
    }),
    { dispose: () => void engine.dispose() },
  );
  // Warm the model once a Markdown file is in front of the user.
  const maybePreload = () => {
    if (vscode.window.activeTextEditor?.document.languageId === "markdown") controller.preload();
  };
  const timer = setTimeout(maybePreload, 1500);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) }, vscode.window.onDidChangeActiveTextEditor(maybePreload));
  return { controller, engine };
}

export function deactivate(): void {
  // disposables registered on the context handle cleanup
}
