// Opt-in live evaluation against TypeSafe's Jev API; needs TYPESAFE_API_KEY and is not run in CI.
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

let misses = 0;
console.log(["fixture", "expected", "label", "confidence", "settles", "ms"].join("\t"));
for (const file of readdirSync(fixtures).filter((f) => f.endsWith(".txt")).sort()) {
  const [name, expected] = file.split(".");
  const started = performance.now();
  const got = classifyScreen(readFileSync(join(fixtures, file), "utf8"), { runner: sh, env: process.env });
  const ms = Math.round(performance.now() - started);
  const floor = SCREEN_LABELS[got?.label]?.minConfidence ?? Infinity;
  const settles = Boolean(got) && got.confidence >= floor;
  // A wrong label only harms when it clears its threshold; below it the helper keeps waiting.
  if (got?.label !== expected && settles) misses++;
  console.log([name, expected, got?.label ?? "(failed)", got?.confidence?.toFixed(3) ?? "-", settles ? "yes" : "no", ms].join("\t"));
}
console.log(`${misses} misclassified above threshold`);
process.exitCode = misses ? 1 : 0;
