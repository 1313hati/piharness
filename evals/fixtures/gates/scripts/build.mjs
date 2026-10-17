// Build gate: every helper exported by src/*.ts must be part of the public
// surface (re-exported from src/index.ts). This is what "the package builds"
// means here — no bundler, no deps.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const srcDir = join(import.meta.dirname, "..", "src");
const index = readFileSync(join(srcDir, "index.ts"), "utf8");

const missing = [];
for (const file of readdirSync(srcDir)) {
  if (!file.endsWith(".ts") || file === "index.ts") continue;
  const source = readFileSync(join(srcDir, file), "utf8");
  for (const match of source.matchAll(/export (?:function|const|class) (\w+)/g)) {
    const name = match[1];
    if (!new RegExp(`\\b${name}\\b`).test(index)) missing.push(`${name} (${file})`);
  }
}

if (missing.length > 0) {
  console.error(`build failed: not exported from src/index.ts: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("build passed");
