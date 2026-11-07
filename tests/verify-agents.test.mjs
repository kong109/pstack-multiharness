import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brief, defaultEntries, judge, planSeat, sandbox, splitEntries } from "../plugins/pstack/skills/pstack-verify-agents/scripts/verify-agents.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-verify-test-"));
  directories.push(dir);
  return dir;
};

const all = () => true;

test("entries split on commas and spaces but keep a spaced effort with its entry", () => {
  expect(splitEntries(["claude", "muse->pi", "@max,", "gpt-6.1-sol->opencode@high,codex"])).toEqual(["claude", "muse->pi @max", "gpt-6.1-sol->opencode@high", "codex"]);
});

test("a seat resolves at low effort unless the entry names one, and a harness without effort gets none", () => {
  expect(planSeat("muse", { installed: all })).toEqual({ entry: "muse", harness: "muse", model: "muse-wonder-full-1.0", effort: "low", problems: [] });
  expect(planSeat("claude @max", { installed: all })).toMatchObject({ harness: "claude", model: "opus", effort: "max", problems: [] });
  expect(planSeat("agy", { installed: all })).toMatchObject({ harness: "agy", effort: null, problems: [] });
});

test("each kind of problem is named, and an unregistered harness says whether it is installed", () => {
  expect(planSeat("muse->kimi", { installed: (c) => c === "kimi" }).problems).toEqual([
    expect.objectContaining({ kind: "unregistered", harness: "kimi", installed: true }),
  ]);
  expect(planSeat("muse->pi", { installed: all }).problems[0]).toMatchObject({ kind: "provider" });
  expect(planSeat("opus->codex", { installed: all }).problems[0].kind).toBe("provider");
  expect(planSeat("grok @max", { installed: all }).problems[0].kind).toBe("effort");
  expect(planSeat("codex:gpt-6.1-sol", { installed: all }).problems[0]).toMatchObject({ kind: "grammar" });
  expect(planSeat("codex", { installed: () => false }).problems).toEqual([{ kind: "missing", detail: "codex is not on PATH" }]);
});

test("with no entries, each installed harness gets a seat, and a multi-provider one runs its first provider's default", () => {
  const list = { codex: { command: "codex" }, muse: { command: "muse" }, pi: { command: "pi", providers: { openai: "openai-codex/{model}" } } };
  expect(defaultEntries({ list, installed: (c) => c !== "muse" })).toEqual(["codex", "codex->pi"]);
});

test("the brief names a task and the seats, not the skill or the scripts", () => {
  const text = brief([{ entry: "codex" }, { entry: "muse->pi @max" }]);
  expect(text).toContain("codex, muse->pi @max");
  expect(text).not.toMatch(/arena skill|pane-agent|workrex|\/pstack/i);
});

const seat = (name, harness, model, extra = {}) => ({
  kind: "seat", name, harness, model, effort: "low", access: "write",
  worktree: { path: `/s__worktrees/pstack-${name}`, workrex: `pstack-${name}` }, ids: { window: `w-${name}`, pane: `b-${name}` }, result: true, ...extra,
});
const tab = (name, label) => ({ kind: "tab", window: `w-${name}`, label });
const status = (name, value) => ({ kind: "status", pane: `b-${name}`, status: value });
const planned = [
  { entry: "codex", harness: "codex", model: "gpt-6.1-sol", effort: "low" },
  { entry: "claude", harness: "claude", model: "opus", effort: "low" },
];
const good = [
  { kind: "session", session: "s-user", label: "mine" },
  seat("arena-codex", "codex", "gpt-6.1-sol"), seat("arena-claude", "claude", "opus"),
  tab("arena-codex", "🤖 arena-codex"), tab("arena-claude", "🤖 arena-claude"),
  status("arena-codex", "done"), tab("arena-codex", "✅ arena-codex"),
  status("arena-claude", "done"), tab("arena-claude", "✅ arena-claude"),
];

test("a run where every seat used Workrex and held its done icon passes", () => {
  const verdict = judge(good, planned, { userSession: "s-user" });
  expect(verdict.ok).toBe(true);
  expect(verdict.seats.map((s) => s.name)).toEqual(["arena-codex", "arena-claude"]);
});

test("a done icon replaced afterwards, a git worktree, a missing seat, and a renamed session each fail", () => {
  const flipped = judge([...good, tab("arena-codex", "💬 arena-codex")], planned, { userSession: "s-user" });
  expect(flipped.seats[0].checks).toMatchObject({ tabDone: true, tabStayedDone: false });
  const git = judge([...good, seat("arena-claude", "claude", "opus", { worktree: { path: "/s__worktrees/pstack-arena-claude" } })], planned, { userSession: "s-user" });
  expect(git.seats[1].checks.workrex).toBe(false);
  const native = judge(good.filter((e) => !String(e.name ?? e.window ?? e.pane).includes("claude")), planned, { userSession: "s-user" });
  expect(native.seats[1]).toEqual({ entry: "claude", ok: false, checks: { launched: false } });
  const renamed = judge([...good, { kind: "session", session: "s-user", label: "arena-codex" }], planned, { userSession: "s-user" });
  expect(renamed).toMatchObject({ ok: false, run: { userSessionKept: false } });
  for (const verdict of [flipped, git, native]) expect(verdict.ok).toBe(false);
});

test("an Agent-tool worktree in the sandbox and an unplanned seat fail the run", () => {
  const dir = scratch();
  mkdirSync(join(dir, ".claude", "worktrees", "agent-1"), { recursive: true });
  const verdict = judge([...good, seat("extra", "grok", "grok-4.7")], planned, { sandboxDir: dir, userSession: "s-user" });
  expect(verdict).toMatchObject({ ok: false, run: { noPlainWorktrees: false, noStraySeats: false }, strays: ["extra"], plainWorktrees: ["agent-1"] });
  const elsewhere = judge(good, planned, { userSession: "s-user", worktrees: ["/s", "/s__worktrees/verify-1", "/s__worktrees/verify-1/.claude/worktrees/agent-2"] });
  expect(elsewhere).toMatchObject({ ok: false, run: { noPlainWorktrees: false }, plainWorktrees: ["agent-2"] });
});

const gitIn = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).stdout.trim();

test("the sandbox is made once, refuses uncommitted changes, and drops only old branches nothing has checked out", () => {
  const env = { PSTACK_VERIFY_SANDBOX: join(scratch(), "sandbox") };
  const { dir } = sandbox({ env });
  expect(gitIn(dir, "log", "--format=%s")).toBe("sandbox");
  for (const b of ["old", "fresh"]) gitIn(dir, "branch", b);
  const later = Date.now() + 23 * 3600 * 1000;
  expect(sandbox({ env, now: later }).pruned).toEqual([]);
  expect(sandbox({ env, now: Date.now() + 25 * 3600 * 1000 }).pruned.sort()).toEqual(["fresh", "old"]);
  writeFileSync(join(dir, "README.md"), "edited\n");
  expect(() => sandbox({ env })).toThrow("uncommitted changes");
});
