import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  briefText, close, detectMux, harnessArgs, launch, launchPrompt, list, nudgePrompt, panesRoot, peek, send, sh, waitFor,
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
  expect(ask.slice(ask.indexOf("--from"), ask.indexOf("--from") + 2)).toEqual(["--from", "self"]);
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
