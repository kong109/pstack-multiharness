#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { NAME, fill, foreignRequest, protocolPointer } from "./agent-routes.mjs";
import { harnesses } from "./resolve-models.mjs";
import { classifierEnabled, classifyScreen, screenSettle } from "./screen-classifier.mjs";

const START_MS = 60_000;
const TURN_START_MS = 90_000;
const DEFAULT_WAIT_MS = 1_800_000;
const RESULT_TEXT_LIMIT = 200_000;
const SCREEN_LINES = 60;
const NONE_POLL_MS = 5_000;
const SCREEN_POLL_MS = 2_000;
const QUIET_MS = 15_000;
const PASTE_SETTLE_MS = 200;
// The line ends with Enter, which confirms a menu's highlighted option, so typing waits for a confident read that no dialog is open.
const PARENT_CLEAR_MIN_CONFIDENCE = 0.7;

export const script = fileURLToPath(import.meta.url);

export const panesRoot = (env = process.env) => resolve(env.PSTACK_PANES_DIR ?? join(realpathSync(tmpdir()), "pstack-panes"));

export function sh(cmd, args, { timeoutMs, input } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, input, maxBuffer: 32 * 1024 * 1024 });
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
const systemClock = { now: Date.now, sleep: pause };

export function harnessArgs(harness, { model, effort, access, run }) {
  const spec = harnesses[harness];
  if (!spec.access[access]) throw new Error(`${harness} has no ${access} access profile`);
  const vars = { model, effort: effort ?? "", run, script };
  return [
    ...fill(spec.model, vars),
    ...(effort ? fill(spec.effort, vars) : []),
    ...fill(spec.access[access], vars),
    ...fill(spec.runDir, vars),
  ];
}

export function briefText(userBrief, { run, access, name, parent }) {
  const result = join(run, "result.md");
  const question = join(run, "question.md");
  const askParent = `node ${script} ask-parent --run ${run}`;
  const scope = access === "read"
    ? `Do not modify any file except ${result} and ${question}.`
    : `Change only what the task assigns, plus ${result} and ${question}.`;
  const ask = parent
    ? `If a decision blocks you, write only the question to ${question}, do not write ${result}, run \`${askParent}\`, and end your turn. If that command fails, end your turn anyway, because your parent also sees ${question}. Your parent replies in this terminal.`
    : `If a decision blocks you, write only the question to ${question}, do not write ${result}, and end your turn. Your parent replies in this terminal.`;
  const nesting = access === "write" ? `
## Launching your own pane agents

You may launch pane agents of your own with \`node ${script} launch ...\`. Your name prefix and multiplexer are applied for you, so \`--name fix\` launches \`${name}-fix\`. Every later \`send\`, \`wait\`, \`peek\`, and \`close\` takes the full name the launch printed. When one of your agents asks a question you cannot answer from this brief, write your own question to ${question} that quotes it and names the agent, ask your parent as above, and end your turn. When the answer arrives, pass it down with \`node ${script} send --name <full-name> --text <answer> --answer <questionId>\`.
` : "";
  return `${userBrief.trimEnd()}

## Pane protocol

You are pane agent ${name}. You run in a terminal pane that a person can watch. Your parent agent is not at the keyboard, so nothing can answer a prompt in this terminal.

${protocolPointer}

- Never ask a question in the terminal and never stop at an approval or confirmation prompt.
- ${ask}
- When the work is complete, your last action is to write your complete final report to ${result}. Never write ${result} as a status note or before the work is done. Text after that file is not read.
- ${scope}
${nesting}`;
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

function saveState(state) {
  const path = join(state.run, "state.json");
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n");
  renameSync(temp, path);
}

function readStates(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((entry) => {
    try { return [JSON.parse(readFileSync(join(root, entry, "state.json"), "utf8"))]; } catch { return []; }
  });
}

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

export function herdrMux({ runner, env }) {
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
      state.ids = { ...state.ids, tab: opened.tab.tab_id, pane: opened.root_pane.pane_id };
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
    alive: (state) => call(["pane", "get", state.ids.pane]).ok,
    peek(state) {
      const read = (source) => runner("herdr", ["agent", "read", state.name, "--source", source, "--lines", String(SCREEN_LINES)]);
      // herdr cannot scroll an alternate-screen TUI's history while it is blocked, so fall back to what is on screen.
      let r = read("recent-unwrapped");
      if (r.status !== 0) r = read("visible");
      return r.status === 0 ? screenText(r.stdout) : `(unreadable: ${(r.stderr || r.stdout).trim().slice(0, 200)})`;
    },
    close(state) {
      if (!state.ids?.tab) return true;
      const r = call(["tab", "close", state.ids.tab]);
      return r.ok || r.code === "tab_not_found" || r.code === "not_found";
    },
  };
}

const harnessArgv = ({ command, args, promptArgs, promptFirst }) =>
  promptFirst ? [command, ...promptArgs, ...args] : [command, ...args, ...promptArgs];

function reported(state) {
  if (existsSync(join(state.run, "result.md"))) return true;
  const asked = stamp(join(state.run, "question.md"));
  return asked !== null && asked !== state.questionSeen;
}

function screenText(text) {
  const lines = text.split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.slice(-SCREEN_LINES).join("\n");
}

export function tuiosMux({ runner, env }) {
  const session = env.TUIOS_SESSION;
  const call = (verb, args, timeoutMs) => runner("tuios", [verb, "-s", session, ...args], { timeoutMs: timeoutMs && timeoutMs + 15_000 });
  const agentState = (state) => {
    const r = call("get-agent-state", ["-w", state.name, "--json"]);
    if (r.status !== 0) return "gone";
    try { return JSON.parse(r.stdout).state ?? "unknown"; } catch { return "unknown"; }
  };
  const waitFor = (state, until, timeoutMs) =>
    call("wait-for", ["agent-state", "-w", state.name, "--until", until, "--timeout", String(timeoutMs)], timeoutMs).status === 0;
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
        if (Date.now() >= deadline) return { kind: "timeout" };
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
    launch(state, { cwd, ...launchArgs }) {
      const r = runner("tuios", ["new-window", "-s", session, state.name, "--cwd", cwd, "--no-focus", "--print-id", "--", ...harnessArgv(launchArgs)]);
      if (r.status !== 0) throw new Error(`tuios new-window failed: ${(r.stderr || r.stdout).trim()}`);
      const id = r.stdout.trim();
      state.ids = { ...state.ids, window: id, pane: id, session };
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
      return settle(state, { fresh: Boolean(state.awaitTurn), timeoutMs });
    },
    wait: (state, timeoutMs) => settle(state, { fresh: Boolean(state.awaitTurn), timeoutMs }),
    keys(state, keys, timeoutMs) {
      const mapped = keys.map((k) => TUIOS_KEYS[k.toLowerCase()] ?? k);
      const r = call("send-keys", ["-w", state.name, mapped.join(" ")]);
      if (r.status !== 0) throw new Error(`tuios send-keys failed: ${(r.stderr || r.stdout).trim()}`);
      for (let i = 0; i < 20 && agentState(state) === "needs_input"; i++) pause(250);
      return settle(state, { fresh: Boolean(state.awaitTurn), timeoutMs });
    },
    alive: (state) => agentState(state) !== "gone",
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

const TMUX_KEYS = { esc: "Escape", escape: "Escape" };

export function tmuxMux({ runner, env, clock }) {
  const tmux = (args) => runner("tmux", args);
  const failure = (r) => (r.stderr || r.stdout).trim().slice(0, 300);
  const capture = (state) => tmux(["capture-pane", "-p", "-J", "-t", state.ids.pane, "-S", `-${SCREEN_LINES}`]);
  const screen = (state) => {
    const r = capture(state);
    return r.status === 0 ? screenText(r.stdout) : null;
  };
  const begun = (state) => {
    if (!state.awaitTurn) return;
    state.awaitTurn = false;
    saveState(state);
  };
  const gone = (state) => {
    const r = tmux(["display-message", "-p", "-t", state.ids.pane, "#{pane_dead}"]);
    return r.status !== 0 || r.stdout.trim() === "1";
  };
  const settle = (state, { fresh, timeoutMs, turnAt = clock.now() }) => {
    const deadline = clock.now() + timeoutMs;
    const startBy = Math.min(deadline, turnAt + TURN_START_MS);
    let starting = fresh;
    let last = screen(state);
    let changedAt = clock.now();
    const labels = new Map();
    for (;;) {
      if (reported(state)) {
        begun(state);
        return { kind: "rest" };
      }
      if (gone(state)) return { kind: "gone" };
      const now = clock.now();
      const current = screen(state);
      if (current !== last) {
        last = current;
        changedAt = now;
        starting = false;
        begun(state);
      }
      if (now >= deadline) return { kind: starting ? "stalled" : "timeout" };
      if (starting && now >= startBy) return { kind: "stalled" };
      if (!starting && current !== null && now - changedAt >= SCREEN_POLL_MS && !labels.has(current)) {
        labels.set(current, classifyScreen(current, { runner, env }));
      }
      const screenLabel = labels.get(current);
      const kind = screenSettle(screenLabel);
      // A harness can hold its banner for a minute while it loads, then read the prompt from argv, so a banner settles only after the start window.
      const loading = kind === "stalled" && now < startBy;
      if (kind && !loading) return { kind, screenLabel };
      if (!starting && !loading && now - changedAt >= QUIET_MS) {
        return screenLabel ? { kind: "quiet", screenLabel } : { kind: "quiet" };
      }
      clock.sleep(SCREEN_POLL_MS);
    }
  };
  const press = (state, keys) => {
    const r = tmux(["send-keys", "-t", state.ids.pane, ...keys]);
    if (r.status !== 0) throw new Error(`tmux send-keys failed: ${failure(r)}`);
  };
  return {
    id: "tmux",
    launch(state, { cwd, ...launchArgs }) {
      const r = tmux(["new-window", "-d", "-P", "-F", "#{pane_id} #{window_id}", "-n", state.name, "-c", cwd, "--", ...harnessArgv(launchArgs)]);
      if (r.status !== 0) throw new Error(`tmux new-window failed: ${failure(r)}`);
      const [pane, window] = r.stdout.trim().split(" ");
      state.ids = { ...state.ids, pane, window };
      state.prompted = true;
      state.awaitTurn = true;
      state.turnAt = clock.now();
      saveState(state);
      return null;
    },
    initial: (state, timeoutMs) => settle(state, { fresh: true, timeoutMs }),
    submit(state, text, timeoutMs) {
      const buffer = `pstack-${state.name}-${process.pid}-${clock.now()}`;
      const loaded = tmux(["set-buffer", "-b", buffer, "--", text]);
      const pasted = loaded.status === 0 && tmux(["paste-buffer", "-p", "-d", "-b", buffer, "-t", state.ids.pane]);
      if (!pasted || pasted.status !== 0) {
        if (gone(state)) return { kind: "gone" };
        return { kind: "error", detail: `tmux paste failed: ${failure(pasted || loaded)}` };
      }
      // The pause keeps a TUI from reading the paste and its Enter as one paste.
      clock.sleep(PASTE_SETTLE_MS);
      press(state, ["Enter"]);
      state.awaitTurn = true;
      state.turnAt = clock.now();
      saveState(state);
      return settle(state, { fresh: true, timeoutMs });
    },
    // A turn that began unwatched, as after launch --no-wait, has had TURN_START_MS to change the screen already.
    wait: (state, timeoutMs) => settle(state, { fresh: Boolean(state.awaitTurn) && !(clock.now() - state.turnAt >= TURN_START_MS), timeoutMs, turnAt: state.turnAt }),
    keys(state, keys, timeoutMs) {
      press(state, keys.map((k) => TMUX_KEYS[k.toLowerCase()] ?? k));
      return settle(state, { fresh: Boolean(state.awaitTurn), timeoutMs });
    },
    alive: (state) => !gone(state),
    peek(state) {
      const r = capture(state);
      return r.status === 0 ? screenText(r.stdout) : `(unreadable: ${failure(r).slice(0, 200)})`;
    },
    close(state) {
      if (!state.ids?.window) return true;
      return tmux(["kill-window", "-t", state.ids.window]).status === 0 || gone(state);
    },
  };
}

const muxes = {
  herdr: {
    detect: (env) => Boolean(env.HERDR_ENV || env.HERDR_PANE_ID),
    paneEnv: "HERDR_PANE_ID",
    paneId: /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/,
    server: (env) => env.HERDR_SOCKET_PATH ?? env.HERDR_WORKSPACE_ID,
    backend: herdrMux,
    blocked: ({ runner }, parent) => {
      const r = herdrJson(runner, ["pane", "get", parent.pane]);
      return r.ok && r.result.pane?.agent_status === "blocked";
    },
    typeInto: ({ runner }, parent, line) => [runner("herdr", ["pane", "run", parent.pane, line])],
  },
  tuios: {
    detect: (env) => env.TUIOS_ENV === "1",
    paneEnv: "TUIOS_PANE_ID",
    paneId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    sessionEnv: "TUIOS_SESSION",
    server: (env) => env.TUIOS_SESSION,
    backend: tuiosMux,
    blocked: ({ runner }, parent) => {
      const r = runner("tuios", ["get-agent-state", "-s", parent.session, "-w", parent.pane, "--json"]);
      try { return r.status === 0 && JSON.parse(r.stdout).state === "needs_input"; } catch { return false; }
    },
    typeInto: ({ runner }, parent, line) => [
      runner("tuios", ["send-text", "-s", parent.session, "-w", parent.pane, line]),
      runner("tuios", ["send-keys", "-s", parent.session, "-w", parent.pane, "Enter"]),
    ],
  },
  tmux: {
    detect: (env) => Boolean(env.TMUX && env.TMUX_PANE),
    paneEnv: "TMUX_PANE",
    paneId: /^%\d+$/,
    server: (env) => env.TMUX,
    backend: tmuxMux,
    blocked({ runner, env }, parent) {
      if (!classifierEnabled(env)) return false;
      const r = runner("tmux", ["capture-pane", "-p", "-t", parent.pane]);
      if (r.status !== 0) return true;
      const classified = classifyScreen(screenText(r.stdout), { runner, env });
      return !classified || classified.label === "dialog_open" || classified.confidence < PARENT_CLEAR_MIN_CONFIDENCE;
    },
    typeInto({ runner, clock }, parent, line) {
      const text = runner("tmux", ["send-keys", "-t", parent.pane, "-l", "--", line]);
      if (text.status !== 0) return [text];
      clock.sleep(PASTE_SETTLE_MS);
      return [text, runner("tmux", ["send-keys", "-t", parent.pane, "Enter"])];
    },
  },
};

export function detectMux(env, requested) {
  if (requested) return requested;
  const found = Object.keys(muxes).filter((id) => muxes[id].detect(env));
  if (found.length > 1) throw new Error(`More than one multiplexer is set in this environment (${found.join(", ")}); pass --mux ${found.join(" or --mux ")}`);
  if (found.length === 1) return found[0];
  throw new Error("Not running inside herdr, tuios, or tmux, so there is no pane to show the agent in. Run it as a native subagent, or ask the user to start herdr, tuios, or tmux.");
}

const muxFor = (id, deps) => {
  if (!Object.hasOwn(muxes, id)) throw new Error(`Unknown mux: ${id} (use ${Object.keys(muxes).join(", ")})`);
  return muxes[id].backend(deps);
};

function parentOf(muxId, env) {
  const { paneEnv, sessionEnv } = muxes[muxId];
  if (!env[paneEnv]) return null;
  return { mux: muxId, pane: env[paneEnv], ...(sessionEnv ? { session: env[sessionEnv] } : {}) };
}

export function selfState(deps) {
  const { env } = deps;
  const matches = readStates(panesRoot(env)).filter((state) => {
    if (!Object.hasOwn(muxes, state.mux) || state.closed) return false;
    const { paneEnv, server } = muxes[state.mux];
    const pane = env[paneEnv];
    const here = server(env);
    return Boolean(pane && here) && state.ids?.pane === pane && state.ids.server === here && muxFor(state.mux, deps).alive(state);
  });
  if (matches.length > 1) {
    throw new Error(`More than one live pane agent claims this pane (${matches.map((s) => s.name).join(", ")}); close the stale one`);
  }
  return matches[0] ?? null;
}

const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

function stamp(path) {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

function pendingQuestion(run) {
  const asked = stamp(join(run, "question.md"));
  return asked !== null && (stamp(join(run, "result.md")) ?? 0) < asked ? String(asked) : null;
}

function conclude(state, mux, settled, { timeoutMs }) {
  const base = { name: state.name, mux: mux.id, harness: state.harness, model: state.model, ...(settled.screenLabel && { screenLabel: settled.screenLabel }) };
  const questionFile = join(state.run, "question.md");
  const resultFile = join(state.run, "result.md");
  const result = readIfPresent(resultFile);
  const questionId = pendingQuestion(state.run);
  if (questionId !== null) {
    const asked = { question: readFileSync(questionFile, "utf8"), questionFile, questionId };
    state.questionSeen = Number(questionId);
    saveState(state);
    if (settled.kind === "blocked") return { ...base, verdict: "blocked", screen: mux.peek(state), ...asked };
    return { ...base, verdict: "question", ...asked };
  }
  if (result !== null) {
    const big = result.length > RESULT_TEXT_LIMIT;
    return { ...base, verdict: "done", resultFile, ...(big ? {} : { result }) };
  }
  if (settled.kind === "blocked") return { ...base, verdict: "blocked", screen: mux.peek(state) };
  if (settled.kind === "gone") return { ...base, verdict: "error", detail: "the pane or its agent is gone (the harness exited)" };
  if (settled.kind === "error") return { ...base, verdict: "error", detail: settled.detail };
  if (settled.kind === "timeout") return { ...base, verdict: "timeout", screen: mux.peek(state) };
  if (settled.kind === "quiet") return { ...base, verdict: "idle", screen: mux.peek(state) };
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

const resolveDeps = ({ runner = sh, env = process.env, clock = systemClock } = {}) => ({ runner, env, clock });

function nestedName(self, given) {
  if (!self) return given;
  if (!NAME.test(given ?? "")) throw new Error(`--name must match ${NAME} (herdr and tuios name limits)`);
  const full = `${self.name}-${given}`;
  if (!NAME.test(full)) {
    throw new Error(`The nested name ${full} is longer than 32 characters; shorten --name ${given}, since your own name ${self.name} is its prefix`);
  }
  return full;
}

export function launch(options, deps) {
  deps = resolveDeps(deps);
  const { env } = deps;
  const { harness, model, effort = null, access = "read", brief, cwd = process.cwd(), wait = true } = options;
  const self = selfState(deps);
  const name = nestedName(self, options.name);
  const dir = statePath(name, env);
  foreignRequest("launch", { harness, model, effort });
  if (!["read", "write"].includes(access)) throw new Error("--access is read or write");
  if (!brief || !existsSync(brief)) throw new Error("--brief must name an existing file");
  if (existsSync(join(dir, "state.json"))) throw new Error(`Pane agent ${name} already exists; close it first`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
  const muxId = detectMux(env, options.mux ?? self?.mux);
  const mux = muxFor(muxId, deps);
  const run = dir;
  if (/[,()\s]/.test(run)) throw new Error(`Run directory ${run} contains a comma, parenthesis, or space; set PSTACK_PANES_DIR to a plain path`);
  if (/[,()\s]/.test(script)) throw new Error(`Helper path ${script} contains a comma, parenthesis, or space, which breaks the agent's ask-parent command; install pstack under a plain path`);

  ownedPrivateDir(panesRoot(env));
  mkdirSync(run, { recursive: true });
  const parent = parentOf(muxId, env);
  writeFileSync(join(run, "brief.md"), briefText(readFileSync(brief, "utf8"), { run, access, name, parent }));
  const state = {
    name, mux: muxId, harness, model, effort, access, run, cwd: resolve(cwd), parent,
    ids: { server: muxes[muxId].server(env) ?? null }, startedAt: new Date().toISOString(),
  };
  saveState(state);

  const spec = harnesses[harness];
  const promptArgs = fill(spec.prompt ?? ["{prompt}"], { prompt: launchPrompt(run) });
  try {
    const args = harnessArgs(harness, { model, effort, access, run });
    const started = mux.launch(state, { command: spec.command, args, cwd: state.cwd, promptArgs, promptFirst: spec.promptFirst });
    if (!wait) return { name, mux: muxId, run, launched: true };
    const settled = started ?? (mux.initial ? mux.initial(state, timeoutMs) : { kind: "rest" });
    return conclude(state, mux, withBrief(state, mux, settled, timeoutMs), { timeoutMs });
  } catch (error) {
    try { mux.close?.(state); } finally { rmSync(run, { recursive: true, force: true }); }
    throw error;
  }
}

export function waitFor(name, options = {}, deps) {
  deps = resolveDeps(deps);
  const state = loadState(name, deps.env);
  const mux = muxFor(state.mux, deps);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
  return conclude(state, mux, withBrief(state, mux, mux.wait(state, timeoutMs), timeoutMs), { timeoutMs });
}

export function send(name, { text, keys, answer, timeoutMs = DEFAULT_WAIT_MS }, deps) {
  deps = resolveDeps(deps);
  if (Boolean(text) === Boolean(keys)) throw new Error("send takes exactly one of --text or --keys");
  if (answer !== undefined && !text) throw new Error("--answer goes with --text");
  const state = loadState(name, deps.env);
  const pending = pendingQuestion(state.run);
  if (answer !== undefined && pending !== answer) {
    // A failed submit already moved the question aside, so a retry is matched against question.md.prev.
    const undelivered = pending === null && state.answered !== answer && String(stamp(join(state.run, "question.md.prev"))) === answer;
    if (!undelivered) {
      const detail = pending !== null ? `the pending question is ${pending}, not ${answer}`
        : state.answered === answer ? `question ${answer} was already answered` : "no question is pending";
      return { name, verdict: "stale", detail };
    }
  }
  const mux = muxFor(state.mux, deps);
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
  const answering = answer ?? pending;
  if (text && answering !== null && settled.kind !== "error") {
    state.answered = answering;
    saveState(state);
  }
  return conclude(state, mux, settled, { timeoutMs });
}

export function askParent(run, deps) {
  deps = resolveDeps(deps);
  const dir = resolve(run ?? "");
  const path = join(dir, "state.json");
  if (!run || !existsSync(path)) throw new Error("--run must name a pane agent's run directory");
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state.run !== dir) throw new Error(`state.json in ${dir} names a different run directory; refusing to use it`);
  if (!NAME.test(state.name ?? "")) throw new Error(`state.json in ${dir} names an invalid agent; refusing to use it`);
  const questionId = pendingQuestion(dir);
  if (questionId === null) throw new Error(`No pending question; write it to ${join(dir, "question.md")} first`);
  if (!state.parent) throw new Error(`${state.name} has no parent pane to ask; end your turn and your parent reads question.md`);
  const { mux: parentMux, pane: parentPane } = state.parent;
  if (!Object.hasOwn(muxes, parentMux) || typeof parentPane !== "string" || !muxes[parentMux].paneId.test(parentPane)) {
    throw new Error(`state.json in ${dir} names an invalid parent pane; refusing to type into it`);
  }
  if (muxes[parentMux].blocked(deps, state.parent)) return { sent: false, reason: "parent pane is blocked", name: state.name, parent: state.parent };
  const line = `[pane-agent ${state.name}] question ${questionId}: ${join(dir, "question.md")}`;
  const failed = muxes[parentMux].typeInto(deps, state.parent, line).find((r) => r.status !== 0);
  if (failed) throw new Error(`Typing into the parent pane failed: ${(failed.stderr || failed.stdout).trim().slice(0, 300)}`);
  return { sent: true, name: state.name, parent: state.parent };
}

export function peek(name, deps) {
  deps = resolveDeps(deps);
  const state = loadState(name, deps.env);
  return { name, screen: muxFor(state.mux, deps).peek(state) };
}

export function close(name, { keep = false } = {}, deps) {
  deps = resolveDeps(deps);
  const state = loadState(name, deps.env);
  const mux = muxFor(state.mux, deps);
  const closed = mux.close(state);
  if (closed && !keep) rmSync(state.run, { recursive: true, force: true });
  if (closed && keep) {
    state.closed = true;
    saveState(state);
  }
  return { name, mux: state.mux, closed, kept: closed ? (keep ? state.run : null) : state.run };
}

export function list({ env = process.env } = {}) {
  return readStates(panesRoot(env)).map(({ name, mux, harness, model, effort, run, startedAt }) => ({ name, mux, harness, model, effort, run, startedAt }));
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
      keys: { type: "string" }, keep: { type: "boolean" }, answer: { type: "string" }, run: { type: "string" },
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
    out = send(values.name, { text: values.text, keys: values.keys, answer: values.answer, timeoutMs }, deps);
  } else if (command === "ask-parent") {
    out = askParent(values.run, deps);
  } else if (command === "peek") {
    out = peek(values.name, deps);
  } else if (command === "close") {
    out = close(values.name, { keep: values.keep }, deps);
  } else if (command === "list") {
    out = list(deps);
  } else {
    throw new Error("Usage: pane-agent.mjs launch|wait|send|ask-parent|peek|close|list [--name NAME] ...");
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
