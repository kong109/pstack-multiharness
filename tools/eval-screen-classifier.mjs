import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sh } from "../plugins/pstack/skills/poteto-mode/scripts/pane-agent.mjs";
import { SCREEN_LABELS, classifierEnabled, classifyScreen } from "../plugins/pstack/skills/poteto-mode/scripts/screen-classifier.mjs";

const fixtures = fileURLToPath(new URL("../tests/fixtures/screens/", import.meta.url));

if (!classifierEnabled(process.env)) {
  console.error("Set TYPESAFE_API_KEY, and leave PSTACK_SCREEN_CLASSIFIER unset or not off.");
  process.exit(1);
}

let confidentMisses = 0;
console.log(["fixture", "expected", "label", "confidence", "settles", "ms"].join("\t"));
for (const file of readdirSync(fixtures).filter((f) => f.endsWith(".txt")).sort()) {
  const [name, expected] = file.split(".");
  const started = performance.now();
  const got = classifyScreen(readFileSync(join(fixtures, file), "utf8"), { runner: sh, env: process.env });
  const ms = Math.round(performance.now() - started);
  const floor = SCREEN_LABELS[got?.label]?.minConfidence ?? Infinity;
  const settles = Boolean(got) && got.confidence >= floor;
  if (got?.label !== expected && settles) confidentMisses++;
  console.log([name, expected, got?.label ?? "(failed)", got?.confidence?.toFixed(3) ?? "-", settles ? "yes" : "no", ms].join("\t"));
}
console.log(`${confidentMisses} misclassified above threshold`);
process.exitCode = confidentMisses ? 1 : 0;
