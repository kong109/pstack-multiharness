#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const token = /^[a-zA-Z0-9_./:-]+$/;

export const harnesses = JSON.parse(readFileSync(new URL("./harnesses.json", import.meta.url), "utf8"));

export function parseEntry(entry) {
  const parts = entry.trim().split("@");
  const [head, explicitEffort] = parts;
  const colon = head.indexOf(":");
  const harness = colon > 0 && Object.hasOwn(harnesses, head.slice(0, colon)) ? head.slice(0, colon) : null;
  const model = harness ? head.slice(colon + 1) : head;
  if (parts.length > 2 || !token.test(head) || !model ||
      (explicitEffort !== undefined && !token.test(explicitEffort))) {
    throw new Error(`Invalid model entry: ${entry}`);
  }
  if (harness && (model === "auto" || model === "inherit-parent")) {
    throw new Error(`Invalid model entry: ${entry} (a ${harness}: entry names a concrete model)`);
  }
  return { harness, model, explicitEffort };
}

export function normalizeLegacyEffort(text) {
  const effortModels = new Set([...text.matchAll(/^\s*effort:\s*(\S+)\s*=/gm)].map((match) => match[1]));
  const variants = new Map();
  for (const line of text.split(/\r?\n/)) {
    const row = line.trim().match(/^\|\s*`([^`]+\/[^`]+)`\s*\|[^|]*\|\s*`([^`]+)`\s*\|$/);
    if (row) variants.set(row[1], row[2]);
  }
  const legacyDefaults = [...variants]
    .filter(([model]) => !effortModels.has(model))
    .map(([model, variant]) => `effort: ${model} = ${variant}`);
  return [text, ...legacyDefaults].join("\n");
}

export function resolveRole(text, role, defaults) {
  text = normalizeLegacyEffort(text);
  const roles = new Map();
  const efforts = new Map();
  for (const source of text.split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith("#") || line.startsWith("```")) continue;
    if (line.startsWith("effort:")) {
      const match = line.match(/^effort:\s*(\S+)\s*=\s*(\S+)$/);
      if (!match || !token.test(match[1]) || !token.test(match[2])) {
        throw new Error(`Invalid effort override: ${line}`);
      }
      if (efforts.has(match[1])) throw new Error(`Duplicate effort override: ${match[1]}`);
      efforts.set(match[1], match[2]);
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (key !== role) continue;
    if (roles.has(key)) throw new Error(`Duplicate role: ${key}`);
    roles.set(key, line.slice(separator + 1).trim());
  }
  const value = roles.get(role) ?? defaults;
  if (!value) throw new Error(`No mapping or defaults for role: ${role}`);
  return value.split(",").map((entry) => {
    const { harness, model, explicitEffort } = parseEntry(entry);
    const effort = explicitEffort ?? efforts.get(harness ? `${harness}:${model}` : model) ?? efforts.get(model) ?? "default";
    return {
      ...(harness && { harness }),
      model: model === "auto" || model === "inherit-parent" ? null : model,
      effort: effort === "default" ? null : effort,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [file, role, defaults, ...extra] = process.argv.slice(2);
    if (!file || !role || extra.length) {
      throw new Error('Usage: resolve-models.mjs <override-file|-> "role" ["default-models"]');
    }
    const text = file === "-" ? "" : readFileSync(file, "utf8");
    console.log(JSON.stringify(resolveRole(text, role, defaults), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
