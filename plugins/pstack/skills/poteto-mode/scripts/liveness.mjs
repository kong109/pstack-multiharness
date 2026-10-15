#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const STALL_MINUTES = 15;
const SETTLE_MINUTES = 3;
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "lsof"]);
const script = fileURLToPath(import.meta.url);

const registry = (dir) => join(dir, "inflight.tsv");
const wake = (dir) => join(dir, "wake");

function dirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function rows(dir) {
  if (!existsSync(registry(dir))) return [];
  return readFileSync(registry(dir), "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"));
}

function save(dir, list) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(registry(dir), list.map((row) => `${row.join("\t")}\n`).join(""));
}

export function start(dir, id, label, worktree = "-") {
  for (const field of [id, label, worktree]) {
    if (!field || /[\t\n]/.test(field)) throw new Error("start takes an agent id, a label and a worktree, none empty or holding a tab");
  }
  save(dir, [...rows(dir).filter(([agent]) => agent !== id), [id, label, worktree === "-" ? "-" : resolve(worktree)]]);
}

export function done(dir, id) {
  if (!id) throw new Error("done takes the agent id");
  save(dir, rows(dir).filter(([agent]) => agent !== id));
}

function transcript(id) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const found = dirs(projects).flatMap((project) => dirs(join(projects, project))
    .map((session) => join(projects, project, session, "subagents", `agent-${id}.jsonl`))
    .filter(existsSync));
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

function lastTurn(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" && entry.type !== "user") continue;
    const content = entry.message?.content;
    return { who: entry.type, kinds: Array.isArray(content) ? content.map((part) => part.type) : ["text"] };
  }
  return { who: "none", kinds: [] };
}

// Processes whose working directory is inside the worktree, or null when lsof is unavailable.
// Shells are left out: an agent's idle Bash tool shell sits in its worktree long after the agent died.
function processesIn(worktree) {
  if (worktree === "-" || !existsSync(worktree)) return [];
  const out = spawnSync("lsof", ["-a", "-d", "cwd", "-F", "pcn"], { encoding: "utf8" });
  if (out.error) return null;
  const root = realpathSync(worktree);
  const names = new Set();
  let pid, command;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n")) {
      const cwd = line.slice(1);
      if ((cwd === root || cwd.startsWith(root + sep)) && pid !== process.pid && !SHELLS.has(command)) names.add(command);
    }
  }
  return [...names].sort();
}

function verdict({ who, kinds }, minutes, processes) {
  if (who === "assistant" && kinds.includes("text") && !kinds.includes("tool_use") && minutes >= SETTLE_MINUTES) return "ENDED";
  if (minutes >= STALL_MINUTES && !processes?.length) return "STALLED";
  return "OK";
}

export function check(dir) {
  const lines = rows(dir).map(([id, label, worktree]) => {
    const path = transcript(id);
    if (!path) return `STALLED ${id} ${label}: no transcript found`;
    const minutes = (Date.now() - statSync(path).mtimeMs) / 60_000;
    const turn = lastTurn(path);
    const processes = processesIn(worktree);
    const running = processes === null ? "unknown (no lsof)" : processes.join(", ") || "nothing";
    return `${verdict(turn, minutes, processes)} ${id} ${label}: last write ${Math.floor(minutes)} min ago, `
      + `last entry ${turn.who}/${turn.kinds.join(",")}, running in worktree: ${running}, transcript ${path}`;
  });
  if (lines.length === 0) lines.push("NO AGENTS IN FLIGHT");
  const pending = existsSync(wake(dir)) ? readdirSync(wake(dir)).filter((name) => name.endsWith(".json")).sort() : [];
  return [...lines, ...pending.map((name) => `PENDING ${join(wake(dir), name)}`)];
}

export function schedule(dir, { title = `${basename(dir)} watchdog`, every = "20" } = {}) {
  const minutes = Number(every);
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error("--every is a whole number of minutes, at least 1");
  mkdirSync(wake(dir), { recursive: true });
  const run = `node "${script}"`;
  return {
    title,
    schedule: { type: "interval", everyMs: minutes * 60_000 },
    prompt: `Watchdog tick: ${title}.
1. Run \`${run} check "${dir}"\`.
2. For each ENDED line, the agent has stopped and its notice may be lost. Read its final message, then audit its work or take over the steps it left. Then run \`${run} done "${dir}" <agent id>\`.
3. For each STALLED line, the agent has written nothing for ${STALL_MINUTES} minutes and nothing runs in its worktree. Read the end of its transcript, then resume it with SendMessage, saying what stopped it and what is on disk.
4. For each PENDING line, pass that file's JSON fields to delegate_task unchanged, then delete the file once T3 Code accepts the task.
5. Record each action in the run's decision trail. If every line is OK and none is PENDING, reply in one line and end the turn.`,
  };
}

export function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { title: { type: "string" }, every: { type: "string" } },
  });
  const [command, dir, ...rest] = positionals;
  if (!dir) throw new Error("usage: liveness.mjs start|done|check|schedule <run dir> ...");
  const run = resolve(dir);
  if (command === "start") return start(run, ...rest);
  if (command === "done") return done(run, rest[0]);
  if (command === "check") return check(run).join("\n");
  if (command === "schedule") return JSON.stringify(schedule(run, values), null, 2);
  throw new Error(`unknown command ${command}; use start, done, check or schedule`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    const out = main(process.argv.slice(2));
    if (out) console.log(out);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
