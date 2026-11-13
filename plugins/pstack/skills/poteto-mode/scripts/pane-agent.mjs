#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { NAME, fill, checkForeignRequest, protocolPointer } from "./foreign-launch.mjs";
import { harnesses } from "./resolve-models.mjs";
import { classifierEnabled, classifyScreen, screenSettle } from "./screen-classifier.mjs";

const START_MS = 60_000;
const TURN_START_MS = 90_000;
const turnPending = (state, now) => Boolean(state.awaitTurn) && !(now - state.turnAt >= TURN_START_MS);
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

export function sh(cmd, args, { timeoutMs, input, cwd } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, input, cwd, maxBuffer: 32 * 1024 * 1024 });
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

You may launch pane agents of your own with \`node ${script} launch ...\`. They run in your working directory, not in worktrees of their own, so give two writers separate files. Your name prefix and multiplexer are applied for you, so \`--name fix\` launches \`${name}-fix\`. Every later \`send\`, \`wait\`, \`peek\`, and \`close\` takes the full name the launch printed. When one of your agents asks a question you cannot answer from this brief, write your own question to ${question} that quotes it and names the agent, ask your parent as above, and end your turn. When the answer arrives, pass it down with \`node ${script} send --name <full-name> --text <answer> --answer <questionId>\`.
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

function git(cwd, args) {
  const r = sh("git", ["-C", cwd, ...args]);
  if (r.status !== 0) throw new Error(`git ${args[0]} in ${cwd} failed: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout.trim();
}

const branchTip = (repo, branch) => sh("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).stdout.trim();

// Branched from the committed HEAD, so the worker never sees the caller's uncommitted changes.
function planWorktree(name, from) {
  const common = git(from, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (basename(common) !== ".git") throw new Error(`${from} is not in a repository with a .git directory, so it cannot get a worktree; pass --in-place`);
  const repo = dirname(common);
  const tree = { repo, path: `${repo}__worktrees/pstack-${name}`, branch: `pstack/${name}`, base: git(from, ["rev-parse", "HEAD"]) };
  if (branchTip(repo, tree.branch) || existsSync(tree.path)) {
    throw new Error(`${tree.branch} or ${tree.path} is left from an earlier ${name}; merge the branch, then remove the worktree and delete the branch, or launch under another --name`);
  }
  return { ...tree, cwd: resolve(tree.path, git(from, ["rev-parse", "--show-prefix"])) };
}

function addWorktree(tree) {
  git(tree.repo, ["worktree", "add", "-b", tree.branch, tree.path, tree.base]);
  return tree;
}

function removeWorktree({ repo, path, branch, base }, discard) {
  const removed = !existsSync(path) || sh("git", ["-C", repo, "worktree", "remove", ...(discard ? ["--force"] : []), path]).status === 0;
  const tip = branchTip(repo, branch);
  const unused = removed && (discard || tip === base) && sh("git", ["-C", repo, "branch", "-D", branch]).status === 0;
  return { path, removed, branch: tip && !unused ? branch : null };
}

// workrex remove asks before it drops a branch with commits, and exits 0 when stdin answers no, so without --force it runs only on an unused branch and the outcome is read from disk.
// With --force it deletes whatever branch the worktree has checked out, which an agent may have switched, so a discard keeps that and deletes only its own branch.
function releaseWorkrex({ repo, path, branch, base, workrex: handle }, { keep, discard }, runner) {
  if (discard) {
    runner("workrex", ["remove", "--force", "--keep-branch", handle], { cwd: repo, input: "" });
    if (!existsSync(path)) sh("git", ["-C", repo, "branch", "-D", branch]);
  } else if (!keep && branchTip(repo, branch) === base) runner("workrex", ["remove", handle], { cwd: repo, input: "" });
  if (existsSync(path)) runner("workrex", ["close", handle], { cwd: repo, input: "" });
  return { path, removed: !existsSync(path), branch: branchTip(repo, branch) ? branch : null };
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

const failure = (r) => (r.stderr || r.stdout).trim().slice(0, 300);

function screenWatch({ runner, env, clock, screen, gone, status = () => null }) {
  const begun = (state) => {
    if (!state.awaitTurn) return;
    state.awaitTurn = false;
    saveState(state);
  };
  return (state, { fresh, timeoutMs, turnAt = clock.now() }) => {
    const deadline = clock.now() + timeoutMs;
    const startBy = Math.min(deadline, turnAt + TURN_START_MS);
    let starting = fresh;
    let last = screen(state);
    let changedAt = clock.now();
    let worked = false;
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
      const told = status(state, turnAt);
      if (told === "blocked") return { kind: "blocked" };
      if (told === "error") return { kind: "error", detail: "the harness reported an error" };
      if (told === "working") {
        worked = true;
        changedAt = now;
        starting = false;
        begun(state);
      }
      if (told === "done" || (told === "idle" && worked)) {
        begun(state);
        return { kind: "rest" };
      }
      if (now >= deadline) return { kind: starting ? "stalled" : "timeout" };
      if (starting && now >= startBy) return { kind: "stalled" };
      if (!starting && told !== "working" && current !== null && now - changedAt >= SCREEN_POLL_MS && !labels.has(current)) {
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
}

export function tmuxMux({ runner, env, clock }) {
  const tmux = (args) => runner("tmux", args);
  const capture = (state) => tmux(["capture-pane", "-p", "-J", "-t", state.ids.pane, "-S", `-${SCREEN_LINES}`]);
  const screen = (state) => {
    const r = capture(state);
    return r.status === 0 ? screenText(r.stdout) : null;
  };
  const gone = (state) => {
    const r = tmux(["display-message", "-p", "-t", state.ids.pane, "#{pane_dead}"]);
    return r.status !== 0 || r.stdout.trim() === "1";
  };
  const settle = screenWatch({ runner, env, clock, screen, gone });
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
      clock.sleep(PASTE_SETTLE_MS);
      press(state, ["Enter"]);
      state.awaitTurn = true;
      state.turnAt = clock.now();
      saveState(state);
      return settle(state, { fresh: true, timeoutMs });
    },
    wait: (state, timeoutMs) => settle(state, { fresh: turnPending(state, clock.now()), timeoutMs, turnAt: state.turnAt }),
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

const REX_KEYS = { esc: "escape", bspace: "backspace", "c-c": "ctrl+c" };
const rexBin = (env) => (env.REX_BIN_DIR ? join(env.REX_BIN_DIR, "rex") : "rex");
const REX_TAIL_BYTES = 65_536;
const rexBlock = (runner, env, session, block, method, args) => {
  const r = runner(rexBin(env), ["block", "call", "-s", session, "-b", block, method, ...(args ? [JSON.stringify(args)] : [])]);
  try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
};
// format returns the start of the scrollback, which can run to megabytes, so read only its tail.
function rexScreen(runner, env, session, block) {
  const head = rexBlock(runner, env, session, block, "format", { format: "text", trim: true, unwrap: true, max_bytes: REX_TAIL_BYTES });
  if (!head || head.id === undefined) return head?.content ?? null;
  const tail = rexBlock(runner, env, session, block, "blob_read", { id: head.id, offset: Math.max(0, head.total - REX_TAIL_BYTES), max_bytes: REX_TAIL_BYTES });
  return tail ? tail.data.slice(tail.data.indexOf("\n") + 1) : null;
}
const shellWord = (word) => `'${word.replaceAll("'", "'\\''")}'`;

// The root program-status record has no id. Records for subagents carry one.
const rexStatus = (runner, env, session, block) => rexBlock(runner, env, session, block, "program_status")?.records?.find((r) => r.id === undefined) ?? null;

export function rexMux({ runner, env, clock }) {
  const rex = (args) => runner(rexBin(env), args);
  const at = (state) => ["-s", state.ids.session, "-b", state.ids.pane];
  const screen = (state) => {
    const text = rexScreen(runner, env, state.ids.session, state.ids.pane);
    return text === null ? null : screenText(text);
  };
  // The shell a Workrex tab types the harness into outlives it, so the harness has exited once that shell is back in the foreground.
  const gone = (state) => {
    const process = rexBlock(runner, env, state.ids.session, state.ids.pane, "process");
    return !process || process.last_exit !== null || (state.ids.shell && process.child?.pid !== undefined && process.foreground?.pid === process.child.pid);
  };
  // A done or idle record from an earlier turn stays until the harness reports again, so only one newer than the turn counts.
  const status = (state, turnAt) => {
    const record = rexStatus(runner, env, state.ids.session, state.ids.pane);
    if (!record) return null;
    if (record.state === "blocked" || record.state === "working") return record.state;
    return Date.parse(record.updated_at) >= turnAt ? record.state : null;
  };
  const settle = screenWatch({ runner, env, clock, screen, gone, status });
  const press = (state, keys) => {
    const r = rex(["send-key", ...at(state), ...keys]);
    if (r.status !== 0) throw new Error(`rex send-key failed: ${failure(r)}`);
  };
  const openTab = (state, cwd, argv) => {
    const session = env.REX_SESSION;
    const r = rex(["window", "new", "-s", session, state.name, "-c", cwd, "--focus=false", "--json", "--", ...argv]);
    let opened = null;
    try { opened = JSON.parse(r.stdout); } catch {}
    if (r.status !== 0 || !opened?.block_ids?.[0]) throw new Error(`rex window new failed: ${failure(r)}`);
    return { session, window: opened.window_id, pane: opened.block_ids[0] };
  };
  const live = (session, block) => rexBlock(runner, env, session, block, "process")?.last_exit === null;
  // The layout file of a launcher's pane holds how many times each of its seats' panes was halved.
  // Launches of one panel run at once, so a lock orders their reads and writes.
  const withLayout = (launcher, change) => {
    const layout = join(panesRoot(env), `rex-layout-${launcher.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
    const lock = `${layout}.lock`;
    for (let i = 0; ; i++) {
      try { mkdirSync(lock); break; } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (i >= 300 || Date.now() - statSync(lock, { throwIfNoEntry: false })?.mtimeMs > 60_000) rmSync(lock, { recursive: true, force: true });
        else clock.sleep(100);
      }
    }
    try {
      let halved = {};
      try { halved = JSON.parse(readFileSync(layout, "utf8")); } catch {}
      const result = change(halved);
      if (Object.keys(halved).length) writeFileSync(layout, JSON.stringify(halved));
      else rmSync(layout, { force: true });
      return result;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  };
  // A seat that works in its launcher's directory opens as a pane in the launcher's tab, so one task's agents stay grouped.
  // A worker with a worktree of its own is a task of its own and gets a tab. The first seat takes half of the launcher's pane. Each later one halves the largest live seat, down then right in turn, which tiles the seats as a grid.
  const openPane = (state, cwd, argv) => {
    const session = env.REX_SESSION;
    return withLayout(env.REX_BLOCK, (halved) => {
      for (const block of Object.keys(halved)) if (!live(session, block)) delete halved[block];
      const [anchor, depth] = Object.entries(halved).sort((a, b) => a[1] - b[1])[0] ?? [env.REX_BLOCK, null];
      const split = depth === null || depth % 2 ? "right" : "below";
      const r = rex(["split", "-s", session, "-b", anchor, "--split", split, "--label", state.name, "-c", cwd, "--focus=false", "--json", "--", ...argv]);
      let opened = null;
      try { opened = JSON.parse(r.stdout); } catch {}
      if (r.status !== 0 || !opened?.block_ids?.[0]) throw new Error(`rex split failed: ${failure(r)}`);
      const pane = opened.block_ids[0];
      if (depth !== null) halved[anchor] = depth + 1;
      halved[pane] = depth === null ? 0 : depth + 1;
      return { session, pane, split: true };
    });
  };
  const openWorkrex = (state, cwd, argv) => {
    const { repo, branch, base, workrex: handle } = state.worktree;
    const marker = join(state.run, "block");
    const script = join(state.run, "agent.sh");
    // Workrex types --agent into the tab's shell, and a long line typed ahead of the shell gets cut, so the argv waits in a script.
    // The script reports the block it runs in, which Workrex does not print, and the worktree it starts in, which worktree_dir can move, then becomes the harness.
    const sub = relative(state.worktree.path, cwd) || ".";
    writeFileSync(script, `printf '%s\\n%s\\n%s\\n' "$REX_SESSION" "$REX_BLOCK" "$(pwd -P)" > ${shellWord(marker)}\ncd ${shellWord(sub)} && exec ${argv.map(shellWord).join(" ")}\n`);
    rmSync(marker, { force: true });
    const r = runner("workrex", ["add", branch, "--name", handle, "--base", base, "--background", "--local", "--agent", `sh ${shellWord(script)}`], { cwd: repo, input: "" });
    if (r.status !== 0) throw new Error(`workrex add failed: ${failure(r)}`);
    const reported = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n") : []);
    for (let i = 0; i < 120 && reported().length < 4; i++) clock.sleep(250);
    const [session, pane, root] = reported();
    if (!root) throw new Error(`workrex add opened ${handle}, but no pane started the agent; the Workrex panes need one with command: <agent>, and Workrex's sandbox is not supported`);
    Object.assign(state.worktree, { path: root, cwd: resolve(root, sub) });
    state.cwd = state.worktree.cwd;
    const inspected = rex(["block", "inspect", "-s", session, pane, "--json"]);
    let window = null;
    try { window = JSON.parse(inspected.stdout).block.window_id; } catch {}
    return { session, window, pane, shell: true };
  };
  return {
    id: "rex",
    launch(state, { cwd, ...launchArgs }) {
      const argv = harnessArgv(launchArgs);
      state.ids = { ...state.ids, ...(state.worktree?.workrex ? openWorkrex(state, cwd, argv) : state.worktree || env.PSTACK_REX_PLACEMENT === "tab" ? openTab(state, cwd, argv) : openPane(state, cwd, argv)) };
      state.prompted = true;
      state.awaitTurn = true;
      state.turnAt = clock.now();
      saveState(state);
      return null;
    },
    initial: (state, timeoutMs) => settle(state, { fresh: true, timeoutMs }),
    submit(state, text, timeoutMs) {
      const typed = rex(["send", ...at(state), "--", text]);
      if (typed.status !== 0) {
        if (gone(state)) return { kind: "gone" };
        return { kind: "error", detail: `rex send failed: ${failure(typed)}` };
      }
      clock.sleep(PASTE_SETTLE_MS);
      press(state, ["enter"]);
      state.awaitTurn = true;
      state.turnAt = clock.now();
      saveState(state);
      return settle(state, { fresh: true, timeoutMs });
    },
    wait: (state, timeoutMs) => settle(state, { fresh: turnPending(state, clock.now()), timeoutMs, turnAt: state.turnAt }),
    keys(state, keys, timeoutMs) {
      press(state, keys.map((k) => (k.length === 1 ? k : REX_KEYS[k.toLowerCase()] ?? k.toLowerCase())));
      for (let i = 0; i < 20 && rexStatus(runner, env, state.ids.session, state.ids.pane)?.state === "blocked"; i++) clock.sleep(250);
      return settle(state, { fresh: Boolean(state.awaitTurn), timeoutMs });
    },
    alive: (state) => !gone(state),
    peek(state) {
      const text = rexScreen(runner, env, state.ids.session, state.ids.pane);
      return text === null ? "(unreadable: rex format failed)" : screenText(text);
    },
    close(state) {
      if (state.ids?.split) {
        const closed = rex(["block", "close", "-s", state.ids.session, state.ids.pane]).status === 0 || gone(state);
        if (closed && state.parent?.pane) withLayout(state.parent.pane, (halved) => { delete halved[state.ids.pane]; });
        return closed;
      }
      if (!state.ids?.window) return true;
      return rex(["window", "close", "-s", state.ids.session, state.ids.window]).status === 0 || gone(state);
    },
  };
}

function screenBlocked({ runner, env }, text) {
  if (text === null) return true;
  const classified = classifyScreen(screenText(text), { runner, env });
  return !classified || classified.label === "dialog_open" || classified.confidence < PARENT_CLEAR_MIN_CONFIDENCE;
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
    blocked(deps, parent) {
      if (!classifierEnabled(deps.env)) return false;
      const r = deps.runner("tmux", ["capture-pane", "-p", "-t", parent.pane]);
      return screenBlocked(deps, r.status === 0 ? r.stdout : null);
    },
    typeInto({ runner, clock }, parent, line) {
      const text = runner("tmux", ["send-keys", "-t", parent.pane, "-l", "--", line]);
      if (text.status !== 0) return [text];
      clock.sleep(PASTE_SETTLE_MS);
      return [text, runner("tmux", ["send-keys", "-t", parent.pane, "Enter"])];
    },
  },
  rex: {
    detect: (env) => Boolean(env.REX_SESSION && env.REX_BLOCK),
    // Rex is the terminal app, so its variables reach any herdr, tuios, or tmux started inside it, and that one is the nearer multiplexer.
    outermost: true,
    paneEnv: "REX_BLOCK",
    paneId: /^block:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    sessionEnv: "REX_SESSION",
    server: (env) => env.REX_SERVER ?? env.REX_SESSION,
    backend: rexMux,
    blocked(deps, parent) {
      const record = rexStatus(deps.runner, deps.env, parent.session, parent.pane);
      if (record) return record.state === "blocked";
      if (!classifierEnabled(deps.env)) return false;
      return screenBlocked(deps, rexScreen(deps.runner, deps.env, parent.session, parent.pane));
    },
    typeInto({ runner, env, clock }, parent, line) {
      const at = ["-s", parent.session, "-b", parent.pane];
      const text = runner(rexBin(env), ["send", ...at, "--", line]);
      if (text.status !== 0) return [text];
      clock.sleep(PASTE_SETTLE_MS);
      return [text, runner(rexBin(env), ["send-key", ...at, "enter"])];
    },
  },
};

export const detectedMuxes = (env) => Object.keys(muxes).filter((id) => muxes[id].detect(env));

export function detectMux(env, requested) {
  if (requested) return requested;
  const detected = detectedMuxes(env);
  const inner = detected.filter((id) => !muxes[id].outermost);
  const found = inner.length > 0 ? inner : detected;
  if (found.length > 1) throw new Error(`More than one multiplexer is set in this environment (${found.join(", ")}); pass --mux ${found.join(" or --mux ")}`);
  if (found.length === 1) return found[0];
  throw new Error("Not running inside herdr, tuios, tmux, or Rex, so there is no pane to show the agent in. Run it as a native subagent, or ask the user to start herdr, tuios, tmux, or Rex.");
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
  const base = {
    name: state.name, mux: mux.id, harness: state.harness, model: state.model,
    ...(state.worktree && { worktree: state.worktree.path, route: state.worktree.workrex ? "workrex" : "git" }), ...(settled.screenLabel && { screenLabel: settled.screenLabel }),
  };
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
  const { harness, model, effort = null, access = "read", brief, cwd = process.cwd(), inPlace = false, wait = true } = options;
  const self = selfState(deps);
  const name = nestedName(self, options.name);
  const dir = statePath(name, env);
  checkForeignRequest("launch", { harness, model, effort });
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
  // A nested agent cannot create a worktree from inside a Codex sandbox, and its child needs its uncommitted edits, so it runs in place.
  const tree = access === "write" && !inPlace && !self ? planWorktree(name, resolve(cwd)) : null;
  // In Rex, Workrex creates the worktree with its tab, so the project's file copies and post_create hooks run and the worker shows in its dashboard.
  const worktree = tree && (muxId === "rex" && deps.runner("workrex", ["--version"]).status === 0 ? { ...tree, workrex: basename(tree.path) } : addWorktree(tree));
  let state = null;
  try {
    mkdirSync(run, { recursive: true });
    const parent = parentOf(muxId, env);
    writeFileSync(join(run, "brief.md"), briefText(readFileSync(brief, "utf8"), { run, access, name, parent }));
    state = {
      name, mux: muxId, harness, model, effort, access, run, cwd: worktree?.cwd ?? resolve(cwd), worktree, parent,
      ids: { server: muxes[muxId].server(env) ?? null }, startedAt: new Date().toISOString(),
    };
    saveState(state);
    const spec = harnesses[harness];
    const promptArgs = fill(spec.prompt ?? ["{prompt}"], { prompt: launchPrompt(run) });
    const args = harnessArgs(harness, { model, effort, access, run });
    const started = mux.launch(state, { command: spec.command, args, cwd: state.cwd, promptArgs, promptFirst: spec.promptFirst });
    if (!wait) return { name, mux: muxId, run, launched: true, ...(worktree && { worktree: worktree.path }) };
    const settled = started ?? (mux.initial ? mux.initial(state, timeoutMs) : { kind: "rest" });
    return conclude(state, mux, withBrief(state, mux, settled, timeoutMs), { timeoutMs });
  } catch (error) {
    try { if (state) mux.close?.(state); } finally {
      rmSync(run, { recursive: true, force: true });
      const left = worktree && (worktree.workrex ? releaseWorkrex(worktree, false, deps.runner) : removeWorktree(worktree));
      if (left && !left.removed) error.message += `; the worktree ${left.path} has changes and was kept`;
    }
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

export function close(name, { keep = false, discard = false } = {}, deps) {
  if (keep && discard) throw new Error("close takes --keep or --discard, not both");
  deps = resolveDeps(deps);
  const state = loadState(name, deps.env);
  const mux = muxFor(state.mux, deps);
  const tree = state.worktree;
  // The tab closes first, because workrex remove deletes the worktree by force after its checks and a running agent could write in between.
  const closed = mux.close(state);
  const worktree = closed && tree && (tree.workrex ? releaseWorkrex(tree, { keep, discard }, deps.runner) : !keep && removeWorktree(tree, discard));
  // A discard that left the worktree or branch keeps the run directory, so close --discard can run again.
  const retain = keep || (discard && worktree && (!worktree.removed || worktree.branch));
  if (closed && !retain) rmSync(state.run, { recursive: true, force: true });
  if (closed && retain) {
    state.closed = true;
    saveState(state);
  }
  return { name, mux: state.mux, closed, kept: closed ? (retain ? state.run : null) : state.run, ...(worktree && { worktree }) };
}

export function list({ env = process.env } = {}) {
  return readStates(panesRoot(env)).map(({ name, mux, harness, model, effort, run, worktree, startedAt }) => ({
    name, mux, harness, model, effort, run, ...(worktree && { worktree: worktree.path }), startedAt,
  }));
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
      keys: { type: "string" }, keep: { type: "boolean" }, discard: { type: "boolean" }, "in-place": { type: "boolean" }, answer: { type: "string" }, run: { type: "string" },
    },
  });
  const timeoutMs = values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]);
  if (timeoutMs !== undefined && !(timeoutMs > 0)) throw new Error("--timeout-ms must be a positive number of milliseconds");
  let out;
  if (command === "launch") {
    out = launch({ ...values, timeoutMs, inPlace: values["in-place"], wait: !values["no-wait"] }, deps);
  } else if (command === "wait") {
    out = waitFor(values.name, { timeoutMs }, deps);
  } else if (command === "send") {
    out = send(values.name, { text: values.text, keys: values.keys, answer: values.answer, timeoutMs }, deps);
  } else if (command === "ask-parent") {
    out = askParent(values.run, deps);
  } else if (command === "peek") {
    out = peek(values.name, deps);
  } else if (command === "close") {
    out = close(values.name, { keep: values.keep, discard: values.discard }, deps);
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
