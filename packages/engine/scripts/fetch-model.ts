// Downloads the default Kokoro model into the standard models directory (used by CI so the
// integration tests and the end-to-end test run against the real voice).
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/engine.js";

const home = path.join(os.homedir(), ".cache", "spokedown");
const engine = new Engine({ modelsDir: path.join(home, "models"), cacheDir: path.join(home, "audio") });
let last = -10;
await engine.prepare(process.argv[2] ?? "kokoro", (e) => {
  if (e.status === "progress" && e.file?.endsWith(".onnx") && e.progress !== undefined && e.progress - last >= 10) {
    last = e.progress;
    console.log(`downloading ${path.basename(e.file)} ${Math.round(e.progress)}%`);
  }
});
console.log("model ready in", path.join(home, "models"));
