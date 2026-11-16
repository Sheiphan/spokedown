// Fails unless every expected platform build of the current version is on the Marketplace.
//   node scripts/verify-published.mjs [--retries 12]
// Used by the release workflow right after publishing; the gallery can lag a few seconds.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const { publisher, name } = pkg;
const version = process.env.VERIFY_VERSION ?? pkg.version; // override is for testing the script
const EXPECTED = ["darwin-arm64", "darwin-x64"];
const retries = Number(process.argv[process.argv.indexOf("--retries") + 1]) || 12;

async function published() {
  const res = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json;api-version=7.2-preview.1" },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: `${publisher}.${name}` }] }], flags: 16 }),
  });
  if (!res.ok) throw new Error(`Marketplace query failed: HTTP ${res.status}`);
  const data = await res.json();
  const ext = data.results?.[0]?.extensions?.[0];
  return new Set((ext?.versions ?? []).filter((v) => v.version === version).map((v) => v.targetPlatform));
}

let missing = EXPECTED;
for (let i = 1; i <= retries; i++) {
  const have = await published().catch((e) => (console.warn(String(e)), new Set()));
  missing = EXPECTED.filter((t) => !have.has(t));
  console.log(`attempt ${i}: ${publisher}.${name}@${version} has [${[...have].join(", ")}]`);
  if (missing.length === 0) {
    console.log("all targets published");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.error(`missing on the Marketplace: ${missing.join(", ")}`);
process.exit(1);
