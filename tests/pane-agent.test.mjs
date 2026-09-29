import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  briefText, close, detectMux, harnessArgs, launch, list, nudgePrompt, peek, send, waitFor,
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
const tuiosEnv = () => ({ PSTACK_PANES_DIR: join(root, "panes"), TUIOS_ENV: "1", TUIOS_SESSION: "work", TUIOS_PANE_ID: "self" });
const runDir = () => join(root, "panes", "arena-a");

const okJson = (result) => ({ status: 0, stdout: JSON.stringify({ id: "x", result }), stderr: "" });
const failJson = (code, message = code) => ({ status: 1, stdout: "", stderr: JSON.stringify({ error: { code, message } }) });
const agent = (status) => okJson({ agent: { agent_status: status } });
const text = (stdout) => ({ status: 0, stdout, stderr: "" });
const write = (file, body) => writeFileSync(join(runDir(), file), body);

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
  expect(claude[5]).toContain(`Edit(/${run}/**)`);
  expect(claude).toContain("AskUserQuestion");
  const writer = harnessArgs("claude", { model: "m", effort: "max", access: "write", run });
  expect(writer).toContain("--effort");
  expect(writer.join(" ")).toContain("Edit,Write,Bash");
});

test("the brief carries the pane protocol with this agent's paths", () => {
  const out = briefText("Do the thing.\n", { run: "/r/a", access: "read" });
  expect(out.startsWith("Do the thing.\n")).toBe(true);
  expect(out).toContain("skills/poteto-mode/SKILL.md before working");
  expect(out).toContain("write only the question to /r/a/question.md");
  expect(out).toContain("write your complete final report to /r/a/result.md");
  expect(out).toContain("Do not modify any file except /r/a/result.md and /r/a/question.md.");
  expect(briefText("x", { run: "/r/a", access: "write" })).toContain("Change only what the task assigns");
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

test("a pending question outranks a result and send answers it, clearing both files", () => {
  const { runner, calls } = scripted({
    ...herdrBase,
    "herdr agent prompt": [
      () => { write("question.md", "Which branch?\n"); write("result.md", "status\n"); return agent("done"); },
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
  expect(() => detectMux({})).toThrow("Not running inside herdr or tuios");
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
    "tuios get-agent-state": [tuiosState("working"), tuiosState("done")],
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
    "tuios get-agent-state": tuiosState("done"),
    "tuios wait-for": () => { write("result.md", "r\n"); return text(""); },
  });
  launch(options({ harness: "claude", model: "claude-opus-5-5", effort: "high" }), { runner, env: tuiosEnv() });
  const argv = calls[0].slice(calls[0].indexOf("--", 3) + 1);
  expect(argv[0]).toBe("claude");
  expect(argv[1]).toContain("brief.md");
  expect(argv[2]).toBe("--model");
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
    "tuios get-agent-state": tuiosState("done"),
    "tuios wait-for": () => { write("result.md", "r\n"); return text(""); },
    "tuios ask-agent": () => { write("result.md", "second\n"); return text("answer printed\n"); },
  });
  launch(options(), { runner, env: tuiosEnv() });
  expect(send("arena-a", { text: "use main" }, { runner, env: tuiosEnv() })).toMatchObject({ verdict: "done", result: "second\n" });
  const ask = calls.find((c) => c[1] === "ask-agent");
  expect(ask).toContain("use main");
  expect(ask.slice(ask.indexOf("--from"), ask.indexOf("--from") + 2)).toEqual(["--from", "self"]);
  close("arena-a", {}, { runner, env: tuiosEnv() });
  expect(calls.at(-1)).toEqual(["tuios", "run-command", "-s", "work", "CloseWindow", "arena-a"]);
});
