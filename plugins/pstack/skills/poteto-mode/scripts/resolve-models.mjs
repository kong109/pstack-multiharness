#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const token = /^[a-zA-Z0-9_./:#-]+$/;

export const harnesses = JSON.parse(readFileSync(new URL("./harnesses.json", import.meta.url), "utf8"));

// One role entry in the sheet grammar setup-pstack writes: `[harness:]model[ @level]`.
export function parseEntry(entry) {
  const text = entry.trim();
  const match = text.match(/^(\S+?)(?:\s+@(\S+))?$/);
  if (match && match[1].includes("@") && !match[2]) {
    throw new Error(`Invalid model entry: ${text} (write the effort after a space, as in \`${text.replace("@", " @")}\`)`);
  }
  const [, head, explicitEffort] = match ?? [];
  if (!head || !token.test(head) || (explicitEffort !== undefined && !token.test(explicitEffort))) {
    throw new Error(`Invalid model entry: ${text}`);
  }
  const colon = head.indexOf(":");
  const harness = colon > 0 && Object.hasOwn(harnesses, head.slice(0, colon)) ? head.slice(0, colon) : null;
  const model = harness ? head.slice(colon + 1) : head;
  if (!model) throw new Error(`Invalid model entry: ${text}`);
  if (harness && (model === "auto" || model === "inherit-parent")) {
    throw new Error(`Invalid model entry: ${text} (a ${harness}: entry names a concrete model)`);
  }
  return { harness, model, explicitEffort };
}

export function resolveRole(text, role, defaults) {
  let value;
  let defaultEffort = "session";
  for (const source of text.split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith("#") || line.startsWith("```")) continue;
    if (/^effort:/.test(line)) {
      throw new Error(`Unsupported line: ${line} (put the effort on each entry, as in \`model @high\`, or use a \`default effort:\` line)`);
    }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1).trim();
    if (key === "default effort") {
      if (!token.test(rest)) throw new Error(`Invalid default effort: ${rest}`);
      defaultEffort = rest;
    } else if (key === role) {
      if (value !== undefined) throw new Error(`Duplicate role: ${key}`);
      value = rest;
    }
  }
  value ??= defaults;
  if (!value) throw new Error(`No mapping or defaults for role: ${role}`);
  return value.split(",").map((entry) => {
    const { harness, model, explicitEffort } = parseEntry(entry);
    // A harness that takes no effort setting names it in the model id, so the sheet default skips it.
    const inherited = harness && harnesses[harness].effort === null ? undefined : defaultEffort;
    const effort = explicitEffort ?? inherited;
    return {
      ...(harness && { harness }),
      model: model === "auto" || model === "inherit-parent" ? null : model,
      effort: effort === undefined || effort === "session" ? null : effort,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    const [file, role, defaults, ...extra] = process.argv.slice(2);
    if (!file || !role || extra.length) {
      throw new Error('Usage: resolve-models.mjs <sheet|-> "role" ["default-models"]');
    }
    const text = file === "-" ? "" : readFileSync(file, "utf8");
    console.log(JSON.stringify(resolveRole(text, role, defaults), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
