#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { harnesses, native, resolveEntry } from "./resolve-models.mjs";

const ROLE = /^(\s*[a-z][a-z ,-]*[a-z]\s*:\s*)(\S.*)$/;
const LEGACY = /^([a-z][a-z0-9-]*):(\S+)(\s+@\S+)?$/;

// An effort written without its space, which both grammars refuse, gets the space their error message asks for.
// The arrow is dropped when the model's own provider already runs on that harness.
export function migrateEntry(entry) {
  const spaced = entry.includes("->") ? entry : entry.replace(/^(\S+?)@([^@\s]+)$/, "$1 @$2");
  const match = LEGACY.exec(spaced);
  if (!match || !Object.hasOwn(harnesses, match[1])) return spaced;
  const [, harness, model, effort = ""] = match;
  let own;
  try { own = resolveEntry({ model, harness: null }).harness ?? native; } catch { own = null; }
  return `${model}${own === harness ? "" : `->${harness}`}${effort}`;
}

export function migrateText(text) {
  return text.split("\n").map((line) => {
    const cr = line.endsWith("\r") ? "\r" : "";
    const match = ROLE.exec(cr ? line.slice(0, -1) : line);
    if (!match || /^\s*(default effort|session hook)\s*:/.test(line)) return line;
    const next = match[2].split(",").map((e) => e.match(/^\s*/)[0] + migrateEntry(e.trim())).join(",");
    return next === match[2] ? line : `${match[1]}${next}${cr}`;
  }).join("\n");
}

export function migrateFile(path, suffix = ".pre-arrow") {
  const text = readFileSync(path, "utf8");
  const next = migrateText(text);
  if (next === text) return { path, changed: false };
  const backup = `${path}${suffix}`;
  if (!existsSync(backup)) copyFileSync(path, backup);
  writeFileSync(path, next);
  return { path, changed: true, backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: migrate-sheet.mjs <sheet-or-preset>...");
    process.exitCode = 1;
  }
  for (const file of files) {
    try {
      const result = migrateFile(file);
      console.log(result.changed ? `migrated ${file} (backup ${result.backup})` : `unchanged ${file}`);
    } catch (error) {
      console.error(`${file}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
