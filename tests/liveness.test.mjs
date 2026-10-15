import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, done, schedule, start } from "../plugins/pstack/skills/poteto-mode/scripts/liveness.mjs";

const script = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/liveness.mjs", import.meta.url));
const lsof = process.platform !== "win32" && !spawnSync("lsof", ["-v"]).error;

let root, run, worktree, children;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pstack-liveness-"));
  run = join(root, "run");
  worktree = join(root, "wt");
  mkdirSync(worktree);
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  children = [];
});
afterEach(() => {
  for (const child of children) child.kill();
  delete process.env.CLAUDE_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

const entry = (type, ...kinds) => JSON.stringify({ type, message: { content: kinds.map((kind) => ({ type: kind })) } });

function transcript(id, minutesAgo, ...lines) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-repo", "session-1", "subagents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `agent-${id}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  const at = (Date.now() - minutesAgo * 60_000) / 1000;
  utimesSync(path, at, at);
}

const verdicts = () => check(run).map((line) => line.split(":")[0]);

function hold(command, args) {
  const child = spawn(command, args, { cwd: worktree, stdio: ["pipe", "ignore", "ignore"] });
  children.push(child);
  return new Promise((ready) => setTimeout(ready, 300));
}

test("start and done keep one row per agent", () => {
  start(run, "a1", "implement", worktree);
  start(run, "b2", "review");
  start(run, "a1", "implement round 2", worktree);
  expect(readFileSync(join(run, "inflight.tsv"), "utf8")).toBe(`b2\treview\t-\na1\timplement round 2\t${worktree}\n`);
  done(run, "b2");
  expect(readFileSync(join(run, "inflight.tsv"), "utf8")).toBe(`a1\timplement round 2\t${worktree}\n`);
});

test("an empty registry reports nothing in flight", () => {
  expect(check(run)).toEqual(["NO AGENTS IN FLIGHT"]);
});

test("a final message left for three minutes is ENDED, a fresh one is still settling", () => {
  start(run, "fin", "deslop");
  transcript("fin", 3.5, entry("user", "tool_result"), entry("assistant", "text"));
  start(run, "new", "review");
  transcript("new", 2.5, entry("assistant", "text"));
  expect(verdicts()).toEqual(["ENDED fin deslop", "OK new review"]);
});

test("a thinking entry is mid-generation, not an end, until it goes quiet for the stall window", () => {
  start(run, "think", "fix");
  transcript("think", 14, entry("assistant", "thinking"));
  expect(verdicts()).toEqual(["OK think fix"]);
  transcript("think", 16, entry("assistant", "thinking"));
  expect(verdicts()).toEqual(["STALLED think fix"]);
});

test("the last turn spans every entry of the last assistant message, and no earlier turn", () => {
  start(run, "split", "implement");
  transcript("split", 5, entry("user", "tool_result"), entry("assistant", "thinking"), entry("assistant", "tool_use"),
    entry("assistant", "text"));
  start(run, "after", "implement");
  transcript("after", 5, entry("assistant", "tool_use"), entry("user", "tool_result"), entry("assistant", "text"));
  expect(verdicts()).toEqual(["OK split implement", "ENDED after implement"]);
});

test("an agent with no transcript is STALLED", () => {
  start(run, "ghost", "worker");
  expect(check(run)).toEqual(["STALLED ghost worker: no transcript found"]);
});

test.skipIf(!lsof)("a quiet agent is OK while a tool runs in its worktree and STALLED once it stops", async () => {
  start(run, "build", "implement", worktree);
  transcript("build", 20, entry("assistant", "text", "tool_use"));
  await hold("sleep", ["30"]);
  expect(check(run)[0]).toMatch(/^OK build implement: .*running in worktree: sleep,/);
  children.pop().kill();
  await new Promise((done) => setTimeout(done, 300));
  expect(verdicts()).toEqual(["STALLED build implement"]);
});

test.skipIf(!lsof)("an idle shell left in the worktree does not keep a dead agent alive", async () => {
  start(run, "dead", "implement", worktree);
  transcript("dead", 20, entry("assistant", "tool_use"));
  await hold("bash", ["-c", "read line"]);
  expect(check(run)[0]).toMatch(/^STALLED dead implement: .*running in worktree: nothing,/);
});

test.skipIf(!lsof)("a final message is not an end while work still runs in the worktree", async () => {
  start(run, "parent", "deslop", worktree);
  transcript("parent", 10, entry("assistant", "text"));
  await hold("sleep", ["30"]);
  expect(verdicts()).toEqual(["OK parent deslop"]);
});

test("each queued delegate_task file is PENDING, and nothing else in the wake folder is", () => {
  mkdirSync(join(run, "wake"), { recursive: true });
  writeFileSync(join(run, "wake", "review-codex.json"), "{}");
  writeFileSync(join(run, "wake", "notes.md"), "");
  expect(check(run)).toEqual(["NO AGENTS IN FLIGHT", `PENDING ${join(run, "wake", "review-codex.json")}`]);
});

test("schedule prints schedule_task arguments that run this script on this run", () => {
  const args = schedule(run, { title: "prefs watchdog", every: "20" });
  expect(Object.keys(args)).toEqual(["title", "schedule", "prompt"]);
  expect(args.schedule).toEqual({ type: "interval", everyMs: 1_200_000 });
  expect(args.prompt).toContain(`node '${script}' check '${run}'`);
  expect(args.prompt).toContain(`node '${script}' done '${run}' <agent id>`);
  expect(existsSync(join(run, "wake"))).toBe(true);
  expect(() => schedule(run, { every: "0" })).toThrow("--every");
});

test("the tick prompt keeps a $ in the run directory literal and refuses a single quote", () => {
  const dollar = join(root, "watch $UNSET run");
  expect(schedule(dollar).prompt).toContain(` check '${dollar}'`);
  expect(() => schedule(join(root, "it's"))).toThrow("single quote");
});

test("the command line checks the registry it is given", () => {
  spawnSync("node", [script, "start", run, "cli", "review"], { env: process.env });
  transcript("cli", 4, entry("assistant", "text"));
  const out = spawnSync("node", [script, "check", run], { encoding: "utf8", env: process.env });
  expect(out.status).toBe(0);
  expect(out.stdout).toStartWith("ENDED cli review: last write 4 min ago");
});
