#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Older Git releases lack `worktree list -z`. With quotePath disabled, Git
// still quotes control characters and backslashes using C string escapes.
function unquote(value) {
  if (!value.startsWith('"')) return value;
  return JSON.parse(value.replace(/\\(?:\\|a|v|[0-7]{1,3})/g, (escape) => {
    if (escape === "\\\\") return escape;
    const code = escape === "\\a" ? 7 : escape === "\\v" ? 11 : parseInt(escape.slice(1), 8);
    return `\\u${code.toString(16).padStart(4, "0")}`;
  }));
}

export function parseWorktrees(text) {
  return text.trimEnd().split(/\r?\n\r?\n/).map((block) => {
    const fields = block.split(/\r?\n/);
    const first = fields[0];
    if (!first?.startsWith("worktree ")) throw new Error("Invalid git worktree record");
    return { path: unquote(first.slice(9)), state: fields.some((field) => /^prunable(?: |$)/.test(field)) ? "prunable" : "ok" };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const result = spawnSync("git", ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    console.error(result.error?.message ?? result.stderr);
    process.exit(1);
  }
  for (const { path, state } of parseWorktrees(result.stdout)) process.stdout.write(`${path}\0${state}\0`);
}
