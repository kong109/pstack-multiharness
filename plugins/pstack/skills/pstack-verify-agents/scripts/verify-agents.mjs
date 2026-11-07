#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { harnesses, native, parseEntry, providers, resolveEntry } from "../../poteto-mode/scripts/resolve-models.mjs";
import { checkForeignTarget } from "../../poteto-mode/scripts/foreign-launch.mjs";

const run = (command, args, opts = {}) => spawnSync(command, args, { encoding: "utf8", ...opts });
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

export const splitEntries = (args) => args.join(" ").split(/,|\s+(?=[^@\s])/).map((e) => e.trim()).filter(Boolean);

export function planSeat(entry, { defaultEffort = "low", installed, registry } = {}) {
  const seat = { entry, problems: [] };
  let parsed;
  try {
    parsed = parseEntry(entry, registry?.harnesses);
  } catch (error) {
    return { ...seat, problems: [{ kind: "grammar", detail: error.message }] };
  }
  try {
    const { harness = native, model, effort } = resolveEntry(parsed, { ...registry, defaultEffort });
    Object.assign(seat, { harness, model, effort });
    checkForeignTarget(entry, { harness, model, effort });
  } catch (error) {
    const unknown = /^Unknown harness: (\S+)/.exec(error.message);
    const kind = unknown ? "unregistered" : /runs no .* models/.test(error.message) ? "provider" : "effort";
    seat.problems.push({ kind, detail: error.message, ...(unknown && { harness: unknown[1], installed: installed(unknown[1]) }) });
    return seat;
  }
  const command = (registry?.harnesses ?? harnesses)[seat.harness].command;
  if (!installed(command)) seat.problems.push({ kind: "missing", detail: `${command} is not on PATH` });
  return seat;
}

// A provider's harness name is its default model; any other harness gets the default model of the first provider it serves.
export function defaultEntries({ list = harnesses, catalog = providers, installed = onPath } = {}) {
  return Object.entries(list).filter(([, spec]) => installed(spec.command)).map(([name, spec]) => {
    if (catalog.some((p) => p.harness === name)) return name;
    const served = catalog.find((p) => spec.providers?.[p.id]);
    return served ? `${served.harness}->${name}` : name;
  });
}

const onPath = (command) => run("sh", ["-c", `command -v "$1"`, "sh", command]).status === 0;

export function plan(entries, options = {}) {
  return entries.map((entry) => planSeat(entry, { installed: onPath, ...options }));
}

export const sandboxPath = (env = process.env) => resolve(env.PSTACK_VERIFY_SANDBOX ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pstack-verify", "sandbox"));

const git = (dir, ...args) => {
  const r = run("git", ["-C", dir, ...args]);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

// A fixed path keeps per-folder trust records, such as Grok's, so a rerun meets no trust prompt.
export function sandbox({ env = process.env, now = Date.now() } = {}) {
  const dir = sandboxPath(env);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "README.md"), "# pstack-verify sandbox\n\nScratch repository for /pstack-verify-agents runs.\n");
    writeFileSync(join(dir, ".gitignore"), ".pstack/\n.workrex/\n");
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=pstack-verify", "-c", "user.email=pstack-verify@localhost", "commit", "-q", "-m", "sandbox");
  }
  const dirty = git(dir, "status", "--porcelain");
  if (dirty) throw new Error(`the sandbox at ${dir} has uncommitted changes; look at them with git -C ${dir} status`);
  const checkedOut = new Set(git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("branch ")).map((l) => l.slice("branch refs/heads/".length)));
  const pruned = [];
  for (const line of git(dir, "for-each-ref", "--format=%(refname:short) %(committerdate:unix)", "refs/heads/").split("\n").filter(Boolean)) {
    const [branch, at] = line.split(" ");
    if (branch === "main" || checkedOut.has(branch) || now - Number(at) * 1000 < 24 * 3600 * 1000) continue;
    git(dir, "branch", "-D", branch);
    pruned.push(branch);
  }
  return { dir, pruned };
}

export const brief = (seats, { task = DEFAULT_TASK } = {}) =>
  `Set this project's arena runners to exactly these agents, one seat each, at low effort unless the entry names one: ${seats.map((s) => s.entry).join(", ")}. Then throw this in the arena: ${task} Commit the final result on your branch. Don't push.\n`;

export const DEFAULT_TASK = "a dependency-free Node `wc` clone in `wc.mjs` that prints line, word, and byte counts for stdin, separated by spaces like `wc` with no flags, with a `node --test` file in `wc.test.mjs` that covers empty input.";

const rexJson = (args) => json(run("rex", [...args, "--json"])) ?? {};

function readStates(panes) {
  if (!existsSync(panes)) return [];
  return readdirSync(panes).flatMap((name) => {
    try {
      const state = JSON.parse(readFileSync(join(panes, name, "state.json"), "utf8"));
      return [{ ...state, result: existsSync(join(panes, name, "result.md")) }];
    } catch {
      return [];
    }
  });
}

export function watch({ log, stop, panes, intervalMs = 1000, maxMs = 2 * 3600 * 1000 }) {
  const seen = new Map();
  const emit = (key, value, event) => {
    const text = JSON.stringify(value);
    if (seen.get(key) === text) return;
    seen.set(key, text);
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  };
  const end = Date.now() + maxMs;
  while (Date.now() < end && !existsSync(stop)) {
    for (const { session_id: session, label: sessionLabel } of rexJson(["session", "list"]).sessions ?? []) {
      emit(`session ${session}`, sessionLabel, { kind: "session", session, label: sessionLabel });
      for (const w of rexJson(["window", "ls", "-s", session]).windows ?? []) {
        emit(`window ${w.window_id}`, w.label, { kind: "tab", session, window: w.window_id, label: w.label });
      }
    }
    for (const a of json(run("workrex", ["status", "--all", "--json"]))?.agents ?? []) {
      emit(`agent ${a.pane_id}`, a.status, { kind: "status", pane: a.pane_id, worktree: a.worktree, workdir: a.workdir, status: a.status });
    }
    for (const s of readStates(panes)) {
      const { name, harness, model, effort, access, worktree, ids, result } = s;
      emit(`seat ${name}`, { worktree, ids, result }, { kind: "seat", name, harness, model, effort, access, worktree, ids, result });
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
}

export const ICONS = { done: "✅", working: "🤖", waiting: "💬" };

// The worktree list is shared by every checkout, so it also catches an Agent-tool worktree under the coordinator's own checkout.
export function judge(events, seats, { sandboxDir, userSession, worktrees = [], icons = ICONS }) {
  const seen = new Map();
  for (const e of events.filter((e) => e.kind === "seat")) seen.set(e.name, { ...seen.get(e.name), ...e });
  const launched = [...seen.values()];
  const tabs = (window) => events.filter((e) => e.kind === "tab" && e.window === window).map((e) => e.label);
  const statuses = (pane) => events.filter((e) => e.kind === "status" && e.pane === pane).map((e) => e.status);
  const unclaimed = new Set(launched.map((s) => s.name));
  const rows = seats.map((seat) => {
    const match = launched.find((s) => unclaimed.has(s.name) && s.harness === seat.harness && s.model === seat.model);
    if (!match) return { entry: seat.entry, ok: false, checks: { launched: false } };
    unclaimed.delete(match.name);
    const labels = tabs(match.ids?.window);
    const firstDone = labels.findIndex((l) => l.startsWith(icons.done));
    const checks = {
      launched: true,
      effort: (match.effort ?? null) === (seat.effort ?? null),
      workrex: match.access !== "write" || Boolean(match.worktree?.workrex),
      tabShown: labels.length > 0,
      tabDone: firstDone >= 0,
      tabStayedDone: firstDone >= 0 && labels.slice(firstDone).every((l) => l.startsWith(icons.done)),
      statusDone: statuses(match.ids?.pane).includes("done"),
      result: Boolean(match.result),
    };
    return { entry: seat.entry, name: match.name, ok: Object.values(checks).every(Boolean), checks, labels };
  });
  const sessionNames = events.filter((e) => e.kind === "session" && e.session === userSession).map((e) => e.label);
  const plainWorktrees = [...new Set([
    ...(sandboxDir && existsSync(join(sandboxDir, ".claude", "worktrees")) ? readdirSync(join(sandboxDir, ".claude", "worktrees")) : []),
    ...worktrees.filter((path) => /[\\/]\.claude[\\/]worktrees[\\/]/.test(path)).map((path) => basename(path)),
  ])];
  const run = {
    userSessionKept: new Set(sessionNames).size <= 1,
    noPlainWorktrees: plainWorktrees.length === 0,
    noStraySeats: unclaimed.size === 0,
  };
  return { ok: rows.every((r) => r.ok) && Object.values(run).every(Boolean), seats: rows, run, strays: [...unclaimed], plainWorktrees };
}

export const readLog = (log) => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const usage = `usage: verify-agents.mjs plan <entry>...
       verify-agents.mjs sandbox
       verify-agents.mjs brief <entry>...
       verify-agents.mjs watch --log <file> --stop <file> --panes <dir>
       verify-agents.mjs judge --log <file> --user-session <id> <entry>...`;

export function main(argv) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    log: { type: "string" }, stop: { type: "string" }, panes: { type: "string" }, "user-session": { type: "string" },
  } });
  const seats = () => plan(positionals.length ? splitEntries(positionals) : defaultEntries());
  if (command === "plan") {
    const planned = seats();
    console.log(JSON.stringify(planned, null, 2));
    return planned.every((s) => !s.problems.length) ? 0 : 2;
  }
  if (command === "sandbox") return console.log(JSON.stringify(sandbox(), null, 2)), 0;
  if (command === "brief") return process.stdout.write(brief(seats())), 0;
  if (command === "watch" && values.log && values.stop && values.panes) return watch(values), 0;
  if (command === "judge" && values.log) {
    const sandboxDir = sandboxPath();
    const worktrees = existsSync(join(sandboxDir, ".git")) ? git(sandboxDir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length)) : [];
    const verdict = judge(readLog(values.log), seats(), { sandboxDir, userSession: values["user-session"], worktrees });
    console.log(JSON.stringify(verdict, null, 2));
    return verdict.ok ? 0 : 1;
  }
  throw new Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
