// Launches a separate VS Code (downloaded into .vscode-test) with this extension and runs suite.cjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = process.env.SPOKEDOWN_EXT_DIR ? path.resolve(process.env.SPOKEDOWN_EXT_DIR) : path.resolve(here, "../..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "spokedown-e2e-ws-"));
fs.copyFileSync(path.resolve(here, "../../../../packages/core/test/fixtures/synthetic/kitchen-sink.md"), path.join(workspace, "kitchen-sink.md"));
fs.mkdirSync(path.join(workspace, ".vscode"));
fs.writeFileSync(
  path.join(workspace, ".vscode/settings.json"),
  JSON.stringify({ "spokedown.audioOutput": "silent", "spokedown.model": process.env.SPOKEDOWN_MODEL ?? "kokoro", "spokedown.speed": 1 }, null, 2),
);

try {
  await runTests({
    // keep the downloaded VS Code (~1 GB) outside the extension folder
    cachePath: path.resolve(here, "../../../../.vscode-test"),
    extensionDevelopmentPath: ext,
    extensionTestsPath: path.join(here, "suite.cjs"),
    launchArgs: [workspace, "--disable-extensions", "--user-data-dir", fs.mkdtempSync(path.join(os.tmpdir(), "spokedown-e2e-ud-")), "--skip-welcome", "--skip-release-notes"],
  });
} catch (e) {
  console.error("e2e failed:", e);
  process.exit(1);
}
