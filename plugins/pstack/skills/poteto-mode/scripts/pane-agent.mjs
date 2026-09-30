#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { foreignTarget, skill } from "./agent-routes.mjs";
import { harnesses } from "./resolve-models.mjs";

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const START_MS = 60_000;
const TURN_START_MS = 90_000;
const DEFAULT_WAIT_MS = 1_800_000;
const RESULT_TEXT_LIMIT = 200_000;
const SCREEN_LINES = 60;
const NONE_POLL_MS = 5_000;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_./:-]*$/;

export const panesRoot = (env = process.env) => resolve(env.PSTACK_PANES_DIR ?? join(realpathSync(tmpdir()), "pstack-panes"));

export function sh(cmd, args, { timeoutMs } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "", timedOut: r.error?.code === "ETIMEDOUT" };
}

function ownedPrivateDir(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  const foreign = typeof process.getuid === "function" && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0);
  if (!info.isDirectory() || info.isSymbolicLink() || foreign) {
    throw new Error(`${root} must be a directory you own that no one else can write to; set PSTACK_PANES_DIR to a private path`);
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const fill = (template, vars) =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (_, key) => vars[key]));

export function harnessArgs(harness, { model, effort, access, run }) {
  const spec = harnesses[harness];
  if (!spec.access[access]) throw new Error(`${harness} has no ${access} access profile`);
  const vars = { model, effort: effort ?? "", run };
  return [
    ...fill(spec.model, vars),
    ...(effort ? fill(spec.effort, vars) : []),
    ...fill(spec.access[access], vars),
    ...fill(spec.runDir, vars),
  ];
}

export function briefText(userBrief, { run, access }) {
  const result = join(run, "result.md");
  const question = join(run, "question.md");
  const scope = access === "read"
    ? `Do not modify any file except ${result} and ${question}.`
    : `Change only what the task assigns, plus ${result} and ${question}.`;
  return `${userBrief.trimEnd()}

## Pane protocol

You run in a terminal pane that a person can watch. Your parent agent is not at the keyboard, so nothing can answer a prompt in this terminal.

Read the poteto-mode instructions at ${skill} before working. If the task supplies a specialist prompt or reference, read it and preserve that specialty. Report evidence and limitations accurately.

- Never ask a question in the terminal and never stop at an approval or confirmation prompt.
- If a decision blocks you, write only the question to ${question}, do not write ${result}, and end your turn. Your parent replies in this terminal.
- When the work is complete, your last action is to write your complete final report to ${result}. Never write ${result} as a status note or before the work is done. Text after that file is not read.
- ${scope}
`;
}

export const launchPrompt = (run) =>
  `Read ${join(run, "brief.md")} and carry it out. Its last section is the pane protocol; follow it exactly.`;

export const nudgePrompt = (run) =>
  `Your last turn ended without ${join(run, "result.md")} or ${join(run, "question.md")}. Reread ${join(run, "brief.md")} and finish it: write your final report to result.md, or the blocking question to question.md.`;

function statePath(name, env) {
  if (!NAME.test(name ?? "")) throw new Error(`--name must match ${NAME} (herdr and tuios name limits)`);
  return join(panesRoot(env), name);
}

function loadState(name, env) {
  const path = join(statePath(name, env), "state.json");
  if (!existsSync(path)) throw new Error(`No pane agent named ${name}`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state.run !== statePath(name, env)) throw new Error(`state.json for ${name} names a different run directory; refusing to use it`);
  return state;
}

const saveState = (state) => writeFileSync(join(state.run, "state.json"), JSON.stringify(state, null, 2) + "\n");

function herdrJson(runner, args, timeoutMs) {
  const r = runner("herdr", args, { timeoutMs: timeoutMs && timeoutMs + 15_000 });
  const text = (r.status === 0 ? r.stdout : r.stderr || r.stdout).trim();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  if (r.status === 0 && body && !body.error) return { ok: true, result: body.result };
  return {
    ok: false,
    code: body?.error?.code ?? (r.timedOut ? "timeout" : "exec_failed"),
    message: body?.error?.message ?? text.slice(0, 500),
  };
}

const HERDR_KEYS = { escape: "esc" };
const TUIOS_KEYS = { esc: "Escape" };

export function herdrMux(runner, env) {
  const call = (args, timeoutMs) => herdrJson(runner, args, timeoutMs);
  const need = (r, what) => { if (!r.ok) throw new Error(`herdr ${what} failed: ${r.code}: ${r.message}`); return r.result; };
  const settled = (r) => {
    if (r.ok) return { kind: r.result.agent.agent_status === "blocked" ? "blocked" : "rest" };
    const kinds = { agent_blocked: "blocked", timeout: "timeout", agent_prompt_stalled: "stalled", agent_not_found: "gone" };
    return { kind: kinds[r.code] ?? "error", detail: `${r.code}: ${r.message}` };
  };
  const status = (state) => {
    const r = call(["agent", "get", state.name]);
    return r.ok ? r.result.agent.agent_status : "gone";
  };
  return {
    id: "herdr",
    launch(state, { args, cwd }) {
      const tabArgs = ["tab", "create", "--cwd", cwd, "--label", state.name, "--no-focus"];
      if (env.HERDR_WORKSPACE_ID) tabArgs.splice(2, 0, "--workspace", env.HERDR_WORKSPACE_ID);
      const opened = need(call(tabArgs), "tab create");
      state.ids = { tab: opened.tab.tab_id, pane: opened.root_pane.pane_id };
      saveState(state);
      const started = call(["agent", "start", state.name, "--kind", harnesses[state.harness].kind, "--pane", state.ids.pane,
        "--timeout", String(START_MS), "--", ...args]);
      if (!started.ok && started.code === "agent_not_ready") return { kind: "blocked", detail: started.message };
      need(started, "agent start");
      return null;
    },
    submit(state, text, timeoutMs) {
      return settled(call(["agent", "prompt", state.name, text, "--wait", "--timeout", String(timeoutMs)], timeoutMs));
    },
    wait(state, timeoutMs) {
      return settled(call(["agent", "wait", state.name, "--timeout", String(timeoutMs)], timeoutMs));
    },
    keys(state, keys, timeoutMs) {
      const mapped = keys.map((k) => HERDR_KEYS[k.toLowerCase()] ?? k);
      need(call(["agent", "send-keys", state.name, ...mapped]), "send-keys");
      for (let i = 0; i < 20 && status(state) === "blocked"; i++) pause(250);
      return this.wait(state, timeoutMs);
    },
    peek(state) {
      const r = runner("herdr", ["agent", "read", state.name, "--source", "recent-unwrapped", "--lines", String(SCREEN_LINES)]);
      return r.status === 0 ? screenText(r.stdout) : `(unreadable: ${(r.stderr || r.stdout).trim().slice(0, 200)})`;
    },
    close(state) {
      if (!state.ids?.tab) return true;
      const r = call(["tab", "close", state.ids.tab]);
      return r.ok || r.code === "tab_not_found" || r.code === "not_found";
    },
  };
}

function screenText(text) {
  const lines = text.split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.slice(-SCREEN_LINES).join("\n");
}

export function tuiosMux(runner, env) {
  const session = env.TUIOS_SESSION;
  const call = (verb, args, timeoutMs) => runner("tuios", [verb, "-s", session, ...args], { timeoutMs: timeoutMs && timeoutMs + 15_000 });
  const agentState = (state) => {
    const r = call("get-agent-state", ["-w", state.name, "--json"]);
    if (r.status !== 0) return "gone";
    try { return JSON.parse(r.stdout).state ?? "unknown"; } catch { return "unknown"; }
  };
  const waitFor = (state, until, timeoutMs) =>
    call("wait-for", ["agent-state", "-w", state.name, "--until", until, "--timeout", String(timeoutMs)], timeoutMs).status === 0;
  const reported = (state) => ["question.md", "result.md"].some((file) => existsSync(join(state.run, file)));
  const settle = (state, { fresh, timeoutMs }) => {
    const deadline = Date.now() + timeoutMs;
    const startBy = Math.min(deadline, Date.now() + TURN_START_MS);
    let starting = fresh;
    let seenWorking = false;
    const begun = () => {
      starting = false;
      if (state.awaitTurn) {
        state.awaitTurn = false;
        saveState(state);
      }
    };
    for (;;) {
      const cur = agentState(state);
      if (cur === "gone") return { kind: "gone" };
      if (cur === "needs_input") return { kind: "blocked" };
      if (cur === "errored") return { kind: "error", detail: "the agent reported errored" };
      if (cur === "working" || cur === "done") seenWorking = true;
      if (reported(state)) {
        begun();
        return { kind: "rest" };
      }
      if (starting && seenWorking) begun();
      if (starting && Date.now() >= startBy) {
        if (cur !== "none") return { kind: "stalled" };
        begun();
      }
      if (!starting) {
        if (cur === "idle" || cur === "done" || (cur === "none" && seenWorking)) return { kind: "rest" };
        if (Date.now() >= deadline) return { kind: "timeout" };
      }
      const until = starting ? "working,needs_input,errored,done" : "idle,done,needs_input,errored";
      const cap = Math.max(1000, (starting ? startBy : deadline) - Date.now());
      const began = Date.now();
      waitFor(state, until, Math.min(NONE_POLL_MS, cap));
      if (Date.now() - began < 200) pause(500);
    }
  };
  return {
    id: "tuios",
    launch(state, { command, args, cwd, prompt, promptFirst }) {
      const argv = promptFirst ? [command, prompt, ...args] : [command, ...args, prompt];
      const r = runner("tuios", ["new-window", "-s", session, state.name, "--cwd", cwd, "--no-focus", "--print-id", "--", ...argv]);
      if (r.status !== 0) throw new Error(`tuios new-window failed: ${(r.stderr || r.stdout).trim()}`);
      state.ids = { window: r.stdout.trim(), session };
      state.prompted = true;
      state.awaitTurn = true;
      saveState(state);
      return null;
    },
    initial: (state, timeoutMs) => settle(state, { fresh: true, timeoutMs }),
    submit(state, text, timeoutMs) {
      const from = env.TUIOS_PANE_ID ? ["--from", env.TUIOS_PANE_ID] : [];
      const r = call("ask-agent", ["-w", state.name, ...from, "--timeout", String(timeoutMs), text], timeoutMs);
      if (r.status !== 0) {
        const out = `${r.stderr}${r.stdout}`;
        if (/agent_blocked/.test(out)) return { kind: "blocked" };
        if (agentState(state) === "gone") return { kind: "gone" };
        if (/time(d)? ?out/i.test(out)) return { kind: "timeout" };
        return { kind: "error", detail: `ask-agent failed: ${out.trim().slice(0, 300)}` };
      }
      return settle(state, { fresh: false, timeoutMs });
    },
    wait: (state, timeoutMs) => settle(state, { fresh: Boolean(state.awaitTurn), timeoutMs }),
    keys(state, keys, timeoutMs) {
      const mapped = keys.map((k) => TUIOS_KEYS[k.toLowerCase()] ?? k);
      const r = call("send-keys", ["-w", state.name, mapped.join(" ")]);
      if (r.status !== 0) throw new Error(`tuios send-keys failed: ${(r.stderr || r.stdout).trim()}`);
      for (let i = 0; i < 20 && agentState(state) === "needs_input"; i++) pause(250);
      return settle(state, { fresh: false, timeoutMs });
    },
    peek(state) {
      const blocked = agentState(state) === "needs_input";
      const r = blocked ? call("peek-prompt", ["-w", state.name]) : call("capture-pane", ["-w", state.name]);
      return r.status === 0 ? screenText(r.stdout) : `(unreadable: ${(r.stderr || r.stdout).trim().slice(0, 200)})`;
    },
    close(state) {
      if (agentState(state) === "gone") return true;
      return call("run-command", ["CloseWindow", state.name]).status === 0 || agentState(state) === "gone";
    },
  };
}

export function detectMux(env, requested) {
  if (requested) return requested;
  const herdr = Boolean(env.HERDR_ENV || env.HERDR_PANE_ID);
  const tuios = env.TUIOS_ENV === "1";
  if (herdr && tuios) throw new Error("Both herdr and tuios are set in this environment; pass --mux herdr or --mux tuios");
  if (herdr) return "herdr";
  if (tuios) return "tuios";
  throw new Error("Not running inside herdr or tuios, so there is no pane to show the agent in. Run it as a native subagent, or ask the user to start herdr or tuios.");
}

const muxFor = (id, runner, env) => {
  if (id === "herdr") return herdrMux(runner, env);
  if (id === "tuios") return tuiosMux(runner, env);
  throw new Error(`Unknown mux: ${id} (use herdr or tuios)`);
};

const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

function conclude(state, mux, settled, { timeoutMs }) {
  const base = { name: state.name, mux: mux.id, harness: state.harness, model: state.model };
  const questionFile = join(state.run, "question.md");
  const resultFile = join(state.run, "result.md");
  const question = readIfPresent(questionFile);
  const result = readIfPresent(resultFile);
  if (question !== null && (result === null || statSync(resultFile).mtimeMs < statSync(questionFile).mtimeMs)) {
    return { ...base, verdict: "question", question, questionFile };
  }
  if (result !== null) {
    const big = result.length > RESULT_TEXT_LIMIT;
    return { ...base, verdict: "done", resultFile, ...(big ? {} : { result }) };
  }
  if (settled.kind === "blocked") return { ...base, verdict: "blocked", screen: mux.peek(state) };
  if (settled.kind === "gone") return { ...base, verdict: "error", detail: "the pane or its agent is gone (the harness exited)" };
  if (settled.kind === "error") return { ...base, verdict: "error", detail: settled.detail };
  if (settled.kind === "timeout") return { ...base, verdict: "timeout", screen: mux.peek(state) };
  if (settled.kind === "rest" && !state.nudged) {
    state.nudged = true;
    saveState(state);
    return conclude(state, mux, mux.submit(state, nudgePrompt(state.run), timeoutMs), { timeoutMs });
  }
  return { ...base, verdict: settled.kind === "stalled" ? "stalled" : "no_result", screen: mux.peek(state) };
}

function deliverBrief(state, mux, timeoutMs) {
  const settled = mux.submit(state, launchPrompt(state.run), timeoutMs);
  if (!["blocked", "gone", "error"].includes(settled.kind)) {
    state.prompted = true;
    saveState(state);
  }
  return settled;
}

const withBrief = (state, mux, settled, timeoutMs) =>
  settled.kind === "rest" && !state.prompted ? deliverBrief(state, mux, timeoutMs) : settled;

export function launch(options, { runner = sh, env = process.env } = {}) {
  const { name, harness, model, effort = null, access = "read", brief, cwd = process.cwd(), wait = true } = options;
  const dir = statePath(name, env);
  if (!Object.hasOwn(harnesses, harness ?? "")) throw new Error(`--harness must be one of ${Object.keys(harnesses).join(", ")}`);
  if (!TOKEN.test(model ?? "")) throw new Error("--model is required and may hold only letters, digits, and . _ / : -");
  if (effort !== null && !TOKEN.test(effort)) throw new Error("--effort may hold only letters, digits, and . _ / : -");
  foreignTarget("launch", { harness, model, effort });
  if (!["read", "write"].includes(access)) throw new Error("--access is read or write");
  if (!brief || !existsSync(brief)) throw new Error("--brief must name an existing file");
  if (existsSync(join(dir, "state.json"))) throw new Error(`Pane agent ${name} already exists; close it first`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
  const muxId = detectMux(env, options.mux);
  const mux = muxFor(muxId, runner, env);
  const run = dir;
  if (/[,()\s]/.test(run)) throw new Error(`Run directory ${run} contains a comma, parenthesis, or space; set PSTACK_PANES_DIR to a plain path`);

  ownedPrivateDir(panesRoot(env));
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "brief.md"), briefText(readFileSync(brief, "utf8"), { run, access }));
  const state = { name, mux: muxId, harness, model, effort, access, run, cwd: resolve(cwd), startedAt: new Date().toISOString() };
  saveState(state);

  const spec = harnesses[harness];
  const prompt = launchPrompt(run);
  try {
    const args = harnessArgs(harness, { model, effort, access, run });
    const started = mux.launch(state, { command: spec.command, args, cwd: state.cwd, prompt, promptFirst: spec.promptFirst });
    if (!wait) return { name, mux: muxId, run, launched: true };
    const settled = started ?? (muxId === "tuios" ? mux.initial(state, timeoutMs) : { kind: "rest" });
    return conclude(state, mux, withBrief(state, mux, settled, timeoutMs), { timeoutMs });
  } catch (error) {
    try { mux.close?.(state); } finally { rmSync(run, { recursive: true, force: true }); }
    throw error;
  }
}

export function waitFor(name, options = {}, { runner = sh, env = process.env } = {}) {
  const state = loadState(name, env);
  const mux = muxFor(state.mux, runner, env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
  return conclude(state, mux, withBrief(state, mux, mux.wait(state, timeoutMs), timeoutMs), { timeoutMs });
}

export function send(name, { text, keys, timeoutMs = DEFAULT_WAIT_MS }, { runner = sh, env = process.env } = {}) {
  if (Boolean(text) === Boolean(keys)) throw new Error("send takes exactly one of --text or --keys");
  const state = loadState(name, env);
  const mux = muxFor(state.mux, runner, env);
  for (const file of ["question.md", "result.md"]) {
    if (existsSync(join(state.run, file))) renameSync(join(state.run, file), join(state.run, `${file}.prev`));
  }
  if (text) {
    state.nudged = false;
    saveState(state);
  }
  const settled = keys
    ? withBrief(state, mux, mux.keys(state, keys.split(/\s+/).filter(Boolean), timeoutMs), timeoutMs)
    : mux.submit(state, /^\s*-/.test(text) ? ` ${text}` : text, timeoutMs);
  return conclude(state, mux, settled, { timeoutMs });
}

export function peek(name, { runner = sh, env = process.env } = {}) {
  const state = loadState(name, env);
  return { name, screen: muxFor(state.mux, runner, env).peek(state) };
}

export function close(name, { keep = false } = {}, { runner = sh, env = process.env } = {}) {
  const state = loadState(name, env);
  const mux = muxFor(state.mux, runner, env);
  const closed = mux.close(state);
  if (closed && !keep) rmSync(state.run, { recursive: true, force: true });
  return { name, mux: state.mux, closed, kept: closed ? (keep ? state.run : null) : state.run };
}

export function list({ env = process.env } = {}) {
  const root = panesRoot(env);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => existsSync(join(root, entry, "state.json")))
    .map((entry) => {
      const { name, mux, harness, model, effort, run, startedAt } = JSON.parse(readFileSync(join(root, entry, "state.json"), "utf8"));
      return { name, mux, harness, model, effort, run, startedAt };
    });
}

const exitCodes = { done: 0 };

export function main(argv, deps = {}) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: "string" }, harness: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
      brief: { type: "string" }, cwd: { type: "string" }, access: { type: "string" }, mux: { type: "string" },
      "timeout-ms": { type: "string" }, "no-wait": { type: "boolean" }, text: { type: "string" },
      keys: { type: "string" }, keep: { type: "boolean" },
    },
  });
  const timeoutMs = values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]);
  if (timeoutMs !== undefined && !(timeoutMs > 0)) throw new Error("--timeout-ms must be a positive number of milliseconds");
  let out;
  if (command === "launch") {
    out = launch({ ...values, timeoutMs, wait: !values["no-wait"] }, deps);
  } else if (command === "wait") {
    out = waitFor(values.name, { timeoutMs }, deps);
  } else if (command === "send") {
    out = send(values.name, { text: values.text, keys: values.keys, timeoutMs }, deps);
  } else if (command === "peek") {
    out = peek(values.name, deps);
  } else if (command === "close") {
    out = close(values.name, { keep: values.keep }, deps);
  } else if (command === "list") {
    out = list(deps);
  } else {
    throw new Error("Usage: pane-agent.mjs launch|wait|send|peek|close|list [--name NAME] ...");
  }
  console.log(JSON.stringify(out, null, 2));
  return out.verdict ? (exitCodes[out.verdict] ?? 2) : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
