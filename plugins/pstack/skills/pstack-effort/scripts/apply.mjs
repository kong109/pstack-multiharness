#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkForeignTarget } from "../../poteto-mode/scripts/foreign-launch.mjs";
import { detectedMuxes } from "../../poteto-mode/scripts/pane-agent.mjs";
import { resolveRole } from "../../poteto-mode/scripts/resolve-models.mjs";
import { parseSheet, allRoleLabels, slotText } from "./sheet.mjs";

const { native } = JSON.parse(readFileSync(new URL("../../poteto-mode/scripts/providers.json", import.meta.url), "utf8"));

const field = (message, name) => new RegExp(String.raw`^${name}:[ \t]*(.+)$`, "m").exec(message)?.[1]?.trim();

const fenced = (message, tag) => new RegExp(`^(\`{3,})${tag}\\n([\\s\\S]*?)\\n\\1[ \\t]*$`, "m").exec(message)?.[2];

export function parseMessage(raw) {
  const message = raw.replace(/\r\n/g, "\n");
  const sheetPath = field(message, "sheet");
  const base = fenced(message, "pstack-base");
  const next = fenced(message, "pstack-sheet");
  if (!sheetPath || base === undefined || next === undefined) {
    throw new Error("message needs a `sheet:` line and fenced ```pstack-base and ```pstack-sheet blocks; render the page again and copy a fresh message");
  }
  return { sheetPath, base: `${base}\n`, next: `${next}\n` };
}

const fmt = (role) => role.slots.map(slotText).join(", ");

export function planApply(current, next, base) {
  const disk = new Map(parseSheet(current).roles.map((r) => [r.role, r]));
  const rendered = parseSheet(base);
  const wanted = parseSheet(next);
  const names = (sheet) => sheet.roles.map((r) => r.role).join("|");
  if (names(rendered) !== names(wanted)) {
    throw new Error("refused: the pasted sheet's roles differ from the roles the page rendered (added, removed or reordered roles)");
  }
  const lines = current.split("\n");
  const changes = [];
  const drifted = [];
  rendered.roles.forEach((role, i) => {
    if (fmt(role) === fmt(wanted.roles[i])) return;
    const there = disk.get(role.role);
    if (!there || fmt(there) !== fmt(role)) {
      drifted.push(role.role);
      return;
    }
    const line = `${role.role}: ${fmt(wanted.roles[i])}`;
    lines[there.line] = lines[there.line].endsWith("\r") ? `${line}\r` : line;
    changes.push({ role: role.role, from: fmt(there), to: fmt(wanted.roles[i]) });
  });
  if (drifted.length) {
    throw new Error(`refused: ${drifted.join(", ")} changed in the file after the page was rendered. Render the page again and redo those edits.`);
  }
  const text = lines.join("\n");
  let foreign = false;
  for (const role of allRoleLabels(text)) {
    for (const { harness = native, model, effort } of resolveRole(text, role)) {
      foreign ||= harness !== native;
      if (harness === "claude" && model?.startsWith("claude-")) {
        throw new Error(`${role}: ${model} is a full model ID, which the Agent tool rejects; write the family name, such as ${model.split("-")[1]}`);
      }
      checkForeignTarget(role, { harness, model: model ?? "inherit-parent", effort });
    }
  }
  return { changes, text, foreign };
}

export function apply({ message, dryRun = false, env = process.env, log = console.log }) {
  const { sheetPath, base, next } = parseMessage(readFileSync(message, "utf8"));
  if (!existsSync(sheetPath)) throw new Error(`sheet not found: ${sheetPath}`);
  const { changes, text, foreign } = planApply(readFileSync(sheetPath, "utf8"), next, base);
  changes.forEach((c) => log(`${c.role}: ${c.from} -> ${c.to}`));
  if (!changes.length) log("no role changed");
  if (dryRun) return { changes };

  const backup = `${sheetPath}.bak`;
  copyFileSync(sheetPath, backup);
  writeFileSync(sheetPath, text);
  log(`wrote ${sheetPath} (backup ${backup})`);
  if (foreign && detectedMuxes(env).length === 0) {
    log("note: this sheet routes roles to another harness. Inside T3 Code those roles run as T3 Code subagents. Elsewhere they need herdr, tuios, tmux, or Rex, and this shell runs in none of them");
  }
  return { changes, backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    const { values } = parseArgs({ options: { message: { type: "string" }, "dry-run": { type: "boolean" } } });
    if (!values.message) throw new Error("usage: apply.mjs --message <file> [--dry-run]");
    apply({ message: values.message, dryRun: values["dry-run"] });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
