#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { normalizeLegacyEffort, resolveRole } from "../../poteto-mode/scripts/resolve-models.mjs";

export function presetDirectory(scope, project = process.cwd(), home = homedir()) {
  if (scope === "user") return join(home, ".agents", "pstack", "presets");
  if (scope === "project") return join(project, ".pstack", "presets");
  throw new Error("Scope must be user or project");
}

function presetPath(directory, name) {
  if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(name) || name.length > 64 ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(name)) {
    throw new Error("Preset name must be a portable lowercase name, at most 64 characters");
  }
  return join(directory, `${name}.md`);
}

export function snapshot(text) {
  const rows = normalizeLegacyEffort(text).split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^[a-z][a-z ,\-]*:/.test(line));
  const roles = rows.filter((line) => !line.startsWith("effort:"))
    .map((line) => line.slice(0, line.indexOf(":")));
  if (!roles.length) throw new Error("No role mappings found in source sheet");
  for (const role of roles) resolveRole(rows.join("\n"), role);
  return `# pstack model configuration\n\n${rows.join("\n")}\n`;
}

export function listPresets(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function savePreset(directory, name, source, replace = false) {
  const target = presetPath(directory, name);
  const text = snapshot(readFileSync(source, "utf8"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(target, text, { flag: replace ? "w" : "wx" });
  return target;
}

export function applyPreset(directory, name, target, replace = false) {
  const source = presetPath(directory, name);
  if (resolve(source) === resolve(target)) throw new Error("Target cannot be the preset itself");
  const text = snapshot(readFileSync(source, "utf8"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, { flag: replace ? "w" : "wx" });
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [command, scope, name, file, flag, ...extra] = process.argv.slice(2);
    const directory = presetDirectory(scope);
    if (extra.length || (flag !== undefined && flag !== "--replace")) throw new Error("Invalid arguments");
    if (command === "list" && !name) console.log(JSON.stringify(listPresets(directory)));
    else if (command === "show" && name && !file) console.log(snapshot(readFileSync(presetPath(directory, name), "utf8")));
    else if (command === "save" && name && file) console.log(savePreset(directory, name, file, flag === "--replace"));
    else if (command === "apply" && name && file) console.log(applyPreset(directory, name, file, flag === "--replace"));
    else throw new Error("Usage: presets.mjs list|show|save|apply user|project [name] [sheet-path] [--replace]");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
