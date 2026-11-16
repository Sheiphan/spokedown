// Checks which platform builds of the current version are on the VS Code Marketplace.
//   node scripts/verify-published.mjs [--retries 12]     fail unless every target is published
//   node scripts/verify-published.mjs --has darwin-x64   exit 0 if that target is published, else 1
// The search listing hides a version until verification finishes, so this asks the package
// download endpoint, which answers 200 as soon as the upload is registered.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS } from "./targets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const { publisher, name } = pkg;
const version = process.env.VERIFY_VERSION ?? pkg.version; // override is for testing the script
const EXPECTED = TARGETS;
const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1];

async function has(target) {
  const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${name}/${version}/vspackage?targetPlatform=${target}`;
  const res = await fetch(url);
  await res.body?.cancel();
  return res.status === 200;
}

if (process.argv.includes("--has")) {
  process.exit((await has(arg("--has")).catch(() => false)) ? 0 : 1);
}

const retries = Number(arg("--retries")) || 12;
let missing = EXPECTED;
for (let i = 1; i <= retries; i++) {
  const found = await Promise.all(EXPECTED.map((t) => has(t).catch(() => false)));
  missing = EXPECTED.filter((_, k) => !found[k]);
  console.log(`attempt ${i}: ${publisher}.${name}@${version} published: [${EXPECTED.filter((_, k) => found[k]).join(", ")}]`);
  if (missing.length === 0) {
    console.log("all targets published");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.error(`missing on the Marketplace: ${missing.join(", ")}`);
process.exit(1);
