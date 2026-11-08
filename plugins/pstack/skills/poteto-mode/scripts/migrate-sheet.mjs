#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { harnesses, levelledIds, ownProvider } from "./resolve-models.mjs";

const ROLE = /^(\s*[a-z][a-z ,-]*[a-z]\s*:\s*)(\S.*)$/;
const LEGACY = /^([a-z][a-z0-9-]*):([^\s@]+)(@\S+)?$/;
const levelled = levelledIds();

// A levelled model id becomes the model and an effort; an effort the entry already names wins, except `@session`.
function splitLevel(entry) {
  const model = /^(.+?)(?=->|@|$)/.exec(entry)?.[1];
  if (!levelled.has(model)) return entry;
  const [slug, effort] = levelled.get(model);
  const rest = entry.slice(model.length).replace(/@session$/, "");
  return `${slug}${rest}${rest.includes("@") ? "" : `@${effort}`}`;
}

// An effort written after a space, which the grammar refuses, moves up against the model.
// The arrow is dropped only when the model's own provider runs on that harness, so the entry keeps its harness in every session.
export function migrateEntry(entry) {
  const spaced = /^(\S+)\s+(@\S+)$/.exec(entry);
  const joined = spaced ? spaced[1] + spaced[2] : entry;
  const match = LEGACY.exec(joined);
  if (!match || !Object.hasOwn(harnesses, match[1])) return splitLevel(joined);
  const [, harness, model, effort = ""] = match;
  return splitLevel(`${model}${ownProvider(model)?.harness === harness ? "" : `->${harness}`}${effort}`);
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

export function migrateFile(path, suffix = ".pre-nospace") {
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
