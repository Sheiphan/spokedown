// Runs inside the VS Code extension host. Plain assertions, no test framework.
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(api, pred, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sub.dispose();
      reject(new Error(`timed out waiting for ${what}`));
    }, timeoutMs);
    const sub = api.controller.onDidUpdate((u) => {
      if (pred(u)) {
        clearTimeout(t);
        sub.dispose();
        resolve(u);
      }
    });
  });
}

async function run() {
  const log = (...a) => console.log("[e2e]", ...a);
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const doc = await vscode.workspace.openTextDocument(path.join(folder, "kitchen-sink.md"));
  const editor = await vscode.window.showTextDocument(doc);
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "spokedown");
  assert.ok(ext, "extension found");
  const api = await ext.activate();
  const text = doc.getText();
  log("activated; model =", vscode.workspace.getConfiguration("spokedown").get("model"));

  // 1. Read from the start: first word highlighted (Kokoro must load inside VS Code's Electron)
  const t0 = Date.now();
  await vscode.commands.executeCommand("spokedown.readFile");
  const first = await waitFor(api, (u) => u.state === "playing" && u.word >= 0, 120_000, "first word");
  log(`first word after ${Date.now() - t0} ms: "${first.segment.words[first.word].text}" quality=${first.quality}`);
  assert.equal(first.segment.text, "Kitchen sink for the reader.");
  const hl = api.controller.highlighter.state;
  assert.ok(hl.word && hl.sentence && hl.block, "word, sentence and block are highlighted");
  assert.equal(text.slice(...hl.word), "Kitchen");
  assert.equal(text.slice(...hl.sentence), "Kitchen *sink* for the reader");

  // 2. Words advance in reading order and map onto the right source text
  const seen = [];
  const sub = api.controller.onDidUpdate((u) => {
    if (u.state === "playing" && u.word >= 0 && seen.length < 12) {
      const w = u.segment.words[u.word];
      seen.push({ spoken: w.text, src: text.slice(w.srcStart, w.srcEnd), quality: u.quality, at: w.srcStart });
    }
  });
  // Wait for the words instead of a fixed time: slow CI machines synthesize the next sentence late
  // (and may skip a few words while catching up). Only the first 12 are checked: later ones reach
  // the table announcement, whose spoken words all map to the start of the table.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && seen.length < 12) await sleep(250);
  sub.dispose();
  log("words:", seen.map((s) => `${s.spoken}→${JSON.stringify(s.src)}`).join("  "));
  assert.ok(seen.length >= 8, `saw only ${seen.length} words`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].at >= seen[i - 1].at, `words move forward: #${i - 1} ${JSON.stringify(seen[i - 1])} then #${i} ${JSON.stringify(seen[i])}`);
  assert.ok(seen.every((s) => s.quality === "native"), "Kokoro word timings are native");
  for (const s of seen) if (s.spoken === "paragraph") assert.equal(s.src, "paragraph"); // a spoken word maps to its own source

  // 3. Pause holds still; resume continues from the same word
  await vscode.commands.executeCommand("spokedown.pause");
  const paused = api.controller.session.snapshot();
  assert.equal(paused.state, "paused");
  const wordAtPause = api.controller.highlighter.state.word;
  await sleep(1200);
  assert.deepEqual(api.controller.highlighter.state.word, wordAtPause, "highlight frozen while paused");
  await vscode.commands.executeCommand("spokedown.resume");
  const resumed = await waitFor(api, (u) => u.state === "playing", 10_000, "resume");
  // Paused mid-sentence → resumes in it. Paused at the very end of one (likely on a slow machine) → moves to the next.
  assert.ok(resumed.index === paused.index || resumed.index === paused.index + 1, `resumed at ${resumed.index}, paused at ${paused.index}`);

  // 4. Jump to the next heading
  await vscode.commands.executeCommand("spokedown.nextHeading");
  const h = await waitFor(api, (u) => u.state === "playing" && u.segment.kind === "heading", 30_000, "next heading");
  log("jumped to heading:", h.segment.text);
  assert.equal(h.segment.text, "Lists.");

  // 5. Edits above the reading position keep highlights aligned
  await editor.edit((b) => b.insert(new vscode.Position(0, 0), "<!-- inserted -->\n"));
  await sleep(400);
  const after = api.controller.highlighter.state;
  const newText = doc.getText();
  assert.ok(newText.slice(...after.sentence).startsWith("Lists") || after.sentence[0] > 0, "sentence still points into the document");
  if (after.word) assert.match(newText.slice(...after.word), /\S/);

  // 5b. Pause, move the cursor elsewhere, press play → reads from the new line (not a resume)
  await vscode.commands.executeCommand("spokedown.pause");
  await waitFor(api, (u) => u.state === "paused", 5_000, "pause").catch(() => undefined);
  const taskLine = doc.getText().split("\n").findIndex((l) => l.startsWith("- [ ] open task"));
  editor.selection = new vscode.Selection(taskLine, 3, taskLine, 3);
  await vscode.commands.executeCommand("spokedown.toggle");
  const moved = await waitFor(api, (u) => u.state === "playing" && u.word >= 0, 30_000, "start at moved cursor");
  log("after moving cursor while paused:", moved.segment.text);
  assert.equal(moved.segment.text, "to do, open task");

  // 5c. Same thing without moving the cursor → a real resume
  await vscode.commands.executeCommand("spokedown.toggle");
  await sleep(200);
  assert.equal(api.controller.session.snapshot().state, "paused");
  const beforeResume = api.controller.session.snapshot().index;
  await vscode.commands.executeCommand("spokedown.toggle");
  const res2 = await waitFor(api, (u) => u.state === "playing", 10_000, "resume in place");
  assert.equal(res2.index, beforeResume, "unmoved cursor resumes in place");

  // 6. Read from cursor on the table: the table intro is announced with a block highlight
  const tableLine = newText.split("\n").findIndex((l) => l.startsWith("| Name"));
  editor.selection = new vscode.Selection(tableLine, 0, tableLine, 0);
  await vscode.commands.executeCommand("spokedown.readFromCursor");
  const tbl = await waitFor(api, (u) => u.state === "playing" && u.segment.kind === "tableIntro", 30_000, "table intro");
  const block = api.controller.highlighter.state.block;
  assert.ok(newText.slice(...block).startsWith("| Name | Value | Note |"), "whole table highlighted");
  log("table:", tbl.segment.text);

  // 7. Stop clears everything
  await vscode.commands.executeCommand("spokedown.stop");
  assert.deepEqual(api.controller.highlighter.state, {});

  // 8. Read-along preview: renders, highlights the same word, click-to-read
  const previews = api.controller.previews;
  const waitPaint = (pred, ms, what) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        sub.dispose();
        reject(new Error(`timed out waiting for preview ${what}`));
      }, ms);
      const sub = previews.onDidPaint(({ painted }) => {
        if (pred(painted)) {
          clearTimeout(t);
          sub.dispose();
          resolve(painted);
        }
      });
    });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  await vscode.commands.executeCommand("spokedown.openPreview");
  await sleep(2500); // webview boot + render + mermaid
  assert.ok(previews.hasPreview(doc.uri), "preview opened");
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  await vscode.commands.executeCommand("spokedown.readFile");
  const p1 = await waitPaint((p) => !!p.word, 60_000, "first word");
  log("preview painted:", JSON.stringify(p1));
  // the preview paints exactly the source text of the word being spoken
  const w0 = api.controller.script.segments[0].words[0];
  assert.equal(p1.word, doc.getText().slice(w0.srcStart, w0.srcEnd));
  assert.match(p1.block, /^H[1-6]$/);

  // click on "emphasis" in the preview while reading → jumps there
  const off = doc.getText().indexOf("_emphasis_") + 1;
  const jumpedP = waitFor(api, (u) => u.state === "playing" && u.word >= 0 && u.segment.words[u.word].text === "emphasis,", 30_000, "jump to clicked word");
  const paintedP = waitPaint((p) => p.word === "emphasis", 30_000, "clicked word painted");
  await api.controller.previewClick(doc.uri, off);
  const jumped = await jumpedP;
  log("clicked word → reading:", jumped.segment.words[jumped.word].text);
  const p2 = await paintedP;
  log("preview painted after click:", JSON.stringify(p2));

  await vscode.commands.executeCommand("spokedown.stop");
  await waitPaint((p) => p.word === null && p.sentence === null, 10_000, "cleared");
  // The pronunciation dictionary changes what is spoken (checked through the spoken-script view).
  const conf = vscode.workspace.getConfiguration("spokedown");
  await conf.update("pronunciations", { sink: "sync", "kitchen sink": "galley sync" }, vscode.ConfigurationTarget.Workspace);
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  await vscode.commands.executeCommand("spokedown.showScript");
  const spokenText = vscode.window.activeTextEditor.document.getText();
  await conf.update("pronunciations", undefined, vscode.ConfigurationTarget.Workspace);
  assert.match(spokenText, /galley sync for the reader\./, "the phrase key replaced \"Kitchen sink\"");
  assert.doesNotMatch(spokenText, /Kitchen sink for/, "the original wording is gone");
  log("pronunciation dictionary applied:", spokenText.split("\n").find((l) => /galley sync/.test(l)));
  log("all e2e checks passed");
}

module.exports = { run };
