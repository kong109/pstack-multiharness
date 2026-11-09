import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionReport, summarize, transcriptDir } from "../plugins/pstack/skills/poteto-mode/scripts/role-spend.mjs";

const script = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/role-spend.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "role-spend-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const reply = (id, model, usage) => ({
  type: "assistant",
  message: { id, model, content: [{ type: "text", text: "ok" }], usage },
});
const spawnCall = (id, input) => ({
  type: "assistant",
  message: { id: `call-${id}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Agent", input }], usage: { input_tokens: 1, output_tokens: 1 } },
});
const jsonl = (path, entries) => writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

// Writes a session transcript and one subagent transcript per spawn.
function session(dir, name, spawns) {
  mkdirSync(join(dir, name, "subagents"), { recursive: true });
  jsonl(join(dir, `${name}.jsonl`), [
    reply("main-1", "claude-opus-5-5", { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }),
    ...spawns.map((s, i) => spawnCall(`tool-${i}`, s.input)),
  ]);
  spawns.forEach((s, i) => {
    writeFileSync(join(dir, name, "subagents", `agent-${i}.meta.json`), JSON.stringify({ toolUseId: `tool-${i}`, agentType: s.agentType ?? "general-purpose", description: s.input.description, ...s.meta }));
    jsonl(join(dir, name, "subagents", `agent-${i}.jsonl`), s.lines);
  });
  return join(dir, `${name}.jsonl`);
}

test("a reply split across transcript lines counts once at its largest output, and a synthetic reply not at all", () => {
  const dir = join(root, "dedupe");
  const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 40 };
  const file = session(dir, "s1", [{
    input: { description: "[bug-fix] Fix the parser", model: "opus" },
    lines: [reply("m1", "claude-opus-5-5", { output_tokens: 3 }), reply("m1", "claude-opus-5-5", usage), reply("m1", "claude-opus-5-5", { output_tokens: 0 }), reply("m2", "<synthetic>", usage)],
  }]);
  const [spawn] = sessionReport(file).spawns;
  expect(spawn.usage).toEqual({ input: 2, cacheWrite: 100, cacheRead: 50, output: 40 });
  expect(spawn.ran).toEqual(["claude-opus-5-5"]);
  expect(sessionReport(file).main.usage).toEqual({ input: 11, cacheWrite: 0, cacheRead: 90, output: 6 });
});

test("a tagged spawn on a model the sheet does not give its role is flagged, and one that matches is not", () => {
  const dir = join(root, "routing");
  const file = session(dir, "s1", [
    { input: { description: "[strongest judgment] Design the cache" }, lines: [reply("a", "claude-opus-5-5", { output_tokens: 1 })] },
    { input: { description: "[feature] Add the flag", model: "sonnet", effort: "high" }, lines: [reply("b", "claude-sonnet-5-5", { output_tokens: 1 })] },
    { input: { description: "[arena runners] Draft A", model: "haiku" }, lines: [reply("c", "claude-haiku-5-5", { output_tokens: 1 })] },
  ]);
  const sheet = "strongest judgment: fable@xhigh\nfeature, refactoring: sonnet\narena runners: opus, fable";
  const [strongest, feature, arena] = sessionReport(file, sheet).spawns;
  expect(strongest).toMatchObject({ role: "strongest judgment", requested: { model: null, source: "inherited" }, issue: { kind: "off sheet", detail: "ran opus, sheet says fable" } });
  expect(feature).toMatchObject({ role: "feature", requested: { model: "sonnet", effort: "high", source: "call" }, issue: null });
  expect(arena.issue).toEqual({ kind: "off sheet", detail: "ran haiku, sheet says opus, fable" });
});

test("a role the sheet sends to another harness, an unknown role, a sheet error, and an untagged spawn are each named", () => {
  const dir = join(root, "names");
  const file = session(dir, "s1", [
    { input: { description: "[swarm workers] Lane 1" }, lines: [reply("a", "claude-opus-5-5", { output_tokens: 1 })] },
    { input: { description: "[cartographer] Map it" }, lines: [reply("b", "claude-opus-5-5", { output_tokens: 1 })] },
    { input: { description: "Explore the repo" }, lines: [reply("c", "claude-opus-5-5", { output_tokens: 1 })] },
    { input: { description: "[bug-fix] Fix it" }, lines: [reply("d", "claude-opus-5-5", { output_tokens: 1 })] },
  ]);
  const issues = sessionReport(file, "swarm workers: gpt-6.1-sol@high\nbug-fix: opus\nbug-fix: sonnet").spawns.map((s) => s.issue);
  expect(issues).toEqual([
    { kind: "off sheet", detail: "sheet runs this role on codex" },
    { kind: "unknown role", detail: "cartographer" },
    { kind: "untagged" },
    { kind: "sheet error", detail: "Duplicate role: bug-fix" },
  ]);
});

test("a fork's copy of its parent's replies is charged to the parent, whatever order the files sort in", () => {
  const dir = join(root, "fork");
  const shared = reply("p1", "claude-opus-5-5", { output_tokens: 50 });
  const file = session(dir, "s1", [
    { input: { description: "[swarm workers] Fork" }, meta: { agentType: "fork", isFork: true, parentAgentId: "1" }, lines: [shared, reply("f1", "claude-opus-5-5", { output_tokens: 5 })] },
    { input: { description: "[swarm workers] Parent" }, lines: [shared] },
  ]);
  expect(sessionReport(file).spawns.map((s) => s.usage.output)).toEqual([5, 50]);
});

test("a spawn made inside a subagent reads its call there, and inherit-parent follows that subagent's model", () => {
  const dir = join(root, "nested");
  const file = session(dir, "s1", [
    {
      input: { description: "[feature] Build it", model: "sonnet" },
      lines: [reply("a", "claude-sonnet-5-5", { output_tokens: 1 }), spawnCall("inner", { description: "[strongest judgment] Check it", effort: "max" })],
    },
    { input: { description: "unused" }, meta: { toolUseId: "inner", parentAgentId: "0", spawnDepth: 2, description: "[strongest judgment] Check it" }, lines: [reply("b", "claude-sonnet-5-5", { output_tokens: 1 })] },
  ]);
  const nested = sessionReport(file, "strongest judgment: inherit-parent").spawns[1];
  expect(nested).toMatchObject({ role: "strongest judgment", requested: { model: null, effort: "max", source: "call" }, issue: null });
});

test("a routed agent from before 0.9.133 reads its model and effort from its name", () => {
  const dir = join(root, "legacy");
  const file = session(dir, "s1", [{
    agentType: "pstack-claude-sonnet-5-5-xhigh",
    input: { description: "Review the diff", subagent_type: "pstack-claude-sonnet-5-5-xhigh" },
    lines: [reply("a", "claude-sonnet-5-5", { output_tokens: 7 })],
  }]);
  const report = sessionReport(file);
  expect(report.spawns[0].requested).toEqual({ model: "claude-sonnet-5-5", effort: "xhigh", source: "agent name" });
  expect(summarize([report])).toEqual([
    { role: "(untagged pstack-claude-sonnet-5-5-xhigh)", ran: "claude-sonnet-5-5", effort: "xhigh", n: 1, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 7 } },
  ]);
});

test("the CLI reports the newest session by default and every session with --all", () => {
  const dir = join(root, "cli");
  const spawn = (id) => ({ input: { description: "[bug-fix] Fix it", model: "opus" }, lines: [reply(id, "claude-opus-5-5", { output_tokens: 3 })] });
  const older = session(dir, "older", [spawn("a")]);
  session(dir, "newer", [spawn("b"), spawn("c")]);
  utimesSync(older, new Date("2026-01-01"), new Date("2026-01-01"));
  const sheet = join(root, "empty-sheet.md");
  writeFileSync(sheet, "");
  const run = (...args) => JSON.parse(spawnSync("node", [script, "--dir", dir, "--sheet", sheet, "--json", ...args], { encoding: "utf8" }).stdout);
  expect(run().reports.map((r) => r.session)).toEqual(["newer"]);
  expect(run("--all").summary).toEqual([
    { role: "bug-fix", ran: "claude-opus-5-5", effort: "session", n: 3, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 9 } },
  ]);
  expect(run("--session", "old").reports.map((r) => r.session)).toEqual(["older"]);
  const fails = (...args) => spawnSync("node", [script, "--dir", dir, ...args], { encoding: "utf8" }).stderr.trim();
  expect(fails("--since", "soon")).toBe("--since takes a date such as 2026-11-01, not soon");
  expect(fails("--session", "")).toStartWith("No session in");
  expect(fails("--session", "older", "--all")).toBe("--session picks one session, so drop --all and --since");
});

test("the transcript folder is the working directory with every other character turned into a dash", () => {
  expect(transcriptDir("/Users/me/projects/my.app", "/cfg")).toBe(join("/cfg", "projects", "-Users-me-projects-my-app"));
});
