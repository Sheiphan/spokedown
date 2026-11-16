// Builds a self-contained, platform-specific .vsix.
//
//   node scripts/package.mjs darwin-arm64        # one target
//   node scripts/package.mjs --native            # the machine's own target
//   node scripts/package.mjs --all               # every target in targets.mjs
//   node scripts/package.mjs --update-lock       # regenerate runtime.package-lock.json
//
// The extension bundle keeps a few libraries external (they load data files or native code
// at runtime). This script installs exactly those with npm into a staging folder, drops the
// binaries for other platforms, and runs vsce there. pnpm's symlinked node_modules cannot be
// packaged directly.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, nativeTarget } from "./targets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "../..");
// npm is npm.cmd on Windows, which needs a shell to launch.
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && cmd === "npm" });
const lockFile = path.join(root, "runtime.package-lock.json");

const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function stageManifest() {
  const m = { ...manifest };
  delete m.private;
  delete m.devDependencies;
  delete m.scripts;
  return m;
}

function size(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? size(p) : statSync(p).size;
  }
  return n;
}

function prune(stage, platform, arch) {
  const nm = path.join(stage, "node_modules");
  // onnxruntime-node ships binaries for every platform; keep only the target's.
  const bin = path.join(nm, "onnxruntime-node", "bin", "napi-v3");
  for (const plat of readdirSync(bin)) {
    if (plat !== platform) rmSync(path.join(bin, plat), { recursive: true, force: true });
    else for (const a of readdirSync(path.join(bin, plat))) if (a !== arch) rmSync(path.join(bin, plat, a), { recursive: true, force: true });
  }
  // Browser/WASM runtime and MathJax's prebuilt browser bundles are never loaded in Node.
  // Only the browser/WASM bundle of onnxruntime-web is dropped; its manifest and nested deps stay
  // so `npm list` (run by vsce) still sees a complete tree.
  rmSync(path.join(nm, "onnxruntime-web", "dist"), { recursive: true, force: true });
  for (const rel of ["mathjax-full/es5", "mathjax-full/ts", "mathjax-full/components", "mathjax-full/bundle"]) {
    rmSync(path.join(nm, rel), { recursive: true, force: true });
  }
}

function build(target) {
  const [platform, arch] = target.split("-");
  const stage = path.join(root, "stage", target);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  cpSync(path.join(root, "dist"), path.join(stage, "dist"), { recursive: true, filter: (s) => !s.endsWith(".map") });
  cpSync(path.join(root, "media"), path.join(stage, "media"), { recursive: true });
  cpSync(path.join(root, "assets", "icon.png"), path.join(stage, "assets", "icon.png"));
  cpSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
  cpSync(path.join(root, "CHANGELOG.md"), path.join(stage, "CHANGELOG.md"));
  cpSync(path.join(repoRoot, "README.md"), path.join(stage, "README.md"));
  writeFileSync(path.join(stage, "package.json"), JSON.stringify(stageManifest(), null, 2) + "\n");
  writeFileSync(path.join(stage, ".vscodeignore"), "**/*.map\n");

  const npmFlags = ["--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", `--os=${platform}`, `--cpu=${arch}`];
  if (platform === "linux") npmFlags.push("--libc=glibc"); // sharp ships separate glibc and musl binaries
  if (existsSync(lockFile)) {
    cpSync(lockFile, path.join(stage, "package-lock.json"));
    run("npm", ["ci", ...npmFlags], stage);
  } else {
    throw new Error("runtime.package-lock.json is missing; run with --update-lock first");
  }
  prune(stage, platform, arch);
  console.log(`staged ${target}: node_modules ${(size(path.join(stage, "node_modules")) / 1e6).toFixed(0)} MB`);

  const out = path.join(root, "out");
  mkdirSync(out, { recursive: true });
  const vsix = path.join(out, `${manifest.name}-${manifest.version}-${target}.vsix`);
  run(process.execPath, [path.join(root, "node_modules", "@vscode", "vsce", "vsce"), "package", "--target", target, "--out", vsix], stage);
  console.log(`wrote ${vsix} (${(statSync(vsix).size / 1e6).toFixed(1)} MB)`);
}

const args = process.argv.slice(2);
if (args.includes("--update-lock")) {
  rmSync(lockFile, { force: true });
  const stage = path.join(root, "stage", "lock");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, "package.json"), JSON.stringify(stageManifest(), null, 2) + "\n");
  run("npm", ["install", "--package-lock-only", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
  cpSync(path.join(stage, "package-lock.json"), lockFile);
  console.log("updated runtime.package-lock.json");
} else {
  run("node", ["build.mjs"], root);
  const targets = args.includes("--all") ? TARGETS : args.includes("--native") ? [nativeTarget()] : args.filter((a) => !a.startsWith("--"));
  if (targets.length === 0) throw new Error(`usage: package.mjs <${TARGETS.join("|")}> | --native | --all | --update-lock`);
  for (const t of targets) {
    if (!TARGETS.includes(t)) throw new Error(`unknown target ${t}`);
    build(t);
  }
}
