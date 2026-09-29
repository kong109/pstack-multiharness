#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { installProfiles, routesFromSheet } from "../../poteto-mode/scripts/claude-agents.mjs";
import { parseSheet, slotText } from "./sheet.mjs";

const field = (message, name) => new RegExp(String.raw`^${name}:[ \t]*(.+)$`, "m").exec(message)?.[1]?.trim();

export function parseMessage(raw) {
  const message = raw.replace(/\r\n/g, "\n");
  const sheetPath = field(message, "sheet");
  const fence = /```pstack-sheet\n([\s\S]*?)\n```/.exec(message);
  if (!sheetPath || !fence) throw new Error("message needs a `sheet:` line and a ```pstack-sheet fenced block");
  return { sheetPath, scope: field(message, "scope"), configDir: field(message, "config-dir"), next: `${fence[1]}\n` };
}

const fmt = (role) => role.slots.map(slotText).join(", ");

export function planApply(current, next) {
  const before = parseSheet(current);
  const after = parseSheet(next);
  const names = (sheet) => sheet.roles.map((r) => r.role).join("|");
  if (names(before) !== names(after)) {
    throw new Error("refused: the pasted sheet's roles differ from the file's (added, removed or reordered roles)");
  }
  routesFromSheet(next);
  return after.roles
    .map((role, i) => ({ role: role.role, from: fmt(before.roles[i]), to: fmt(role), foreign: role.slots.filter((s) => s.harness) }))
    .filter((change) => change.from !== change.to);
}

export const defaultConfigDir = ({ scope, sheetPath }) =>
  scope === "project" ? join(dirname(dirname(sheetPath)), ".claude") : join(homedir(), ".claude");

export function apply({ message, dryRun = false, env = process.env, log = console.log }) {
  const { sheetPath, scope, configDir, next } = parseMessage(readFileSync(message, "utf8"));
  if (!existsSync(sheetPath)) throw new Error(`sheet not found: ${sheetPath}`);
  const changes = planApply(readFileSync(sheetPath, "utf8"), next);
  changes.forEach((c) => log(`${c.role}: ${c.from} -> ${c.to}`));
  if (!changes.length) log("no role changed");
  if (dryRun) return { changes };

  const backup = `${sheetPath}.bak`;
  copyFileSync(sheetPath, backup);
  writeFileSync(sheetPath, next);
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
  const foreign = parseSheet(next).roles.some((r) => r.slots.some((s) => s.harness && s.harness !== "claude"));
  if (foreign && !env.HERDR_ENV && !env.HERDR_PANE_ID && env.TUIOS_ENV !== "1") {
    log("note: this sheet routes roles to another harness, which needs herdr or tuios to show its pane; this session has neither");
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
