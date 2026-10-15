#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { installProfiles, routesFromSheet } from "../../poteto-mode/scripts/claude-agents.mjs";
import { parseSheet, slotText } from "./sheet.mjs";

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
  return { sheetPath, scope: field(message, "scope"), configDir: field(message, "config-dir"), base: `${base}\n`, next: `${next}\n` };
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
    changes.push({ role: role.role, from: fmt(there), to: fmt(wanted.roles[i]), foreign: wanted.roles[i].slots.filter((s) => s.harness) });
  });
  if (drifted.length) {
    throw new Error(`refused: ${drifted.join(", ")} changed in the file after the page was rendered. Render the page again and redo those edits.`);
  }
  const text = lines.join("\n");
  routesFromSheet(text);
  return { changes, text };
}

export const defaultConfigDir = ({ scope, sheetPath }) =>
  scope === "project" ? join(dirname(dirname(sheetPath)), ".claude") : join(homedir(), ".claude");

export function apply({ message, dryRun = false, env = process.env, log = console.log }) {
  const { sheetPath, scope, configDir, base, next } = parseMessage(readFileSync(message, "utf8"));
  if (!existsSync(sheetPath)) throw new Error(`sheet not found: ${sheetPath}`);
  const { changes, text } = planApply(readFileSync(sheetPath, "utf8"), next, base);
  changes.forEach((c) => log(`${c.role}: ${c.from} -> ${c.to}`));
  if (!changes.length) log("no role changed");
  if (dryRun) return { changes };

  const backup = `${sheetPath}.bak`;
  copyFileSync(sheetPath, backup);
  writeFileSync(sheetPath, text);
  log(`wrote ${sheetPath} (backup ${backup})`);
  const dir = configDir ?? defaultConfigDir({ scope, sheetPath });
  let agents;
  try {
    ({ agents } = installProfiles(sheetPath, resolve(dir), { check: false }));
  } catch (error) {
    copyFileSync(backup, sheetPath);
    throw new Error(`${error.message}\nrestored ${sheetPath} from ${backup}`);
  }
  log(`installed ${agents.length} routed agent${agents.length === 1 ? "" : "s"} in ${dir}`);
  const foreign = parseSheet(text).roles.some((r) => r.slots.some((s) => s.harness && s.harness !== "claude"));
  if (foreign && !env.HERDR_ENV && !env.HERDR_PANE_ID && env.TUIOS_ENV !== "1") {
    log("note: this sheet routes roles to another harness. Inside T3 Code those roles run as T3 Code subagents. Elsewhere they need herdr or tuios, and this shell has neither multiplexer");
  }
  return { changes, backup, agents };
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
