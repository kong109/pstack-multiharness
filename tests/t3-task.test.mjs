import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnesses } from "../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs";
import { t3Task } from "../plugins/pstack/skills/poteto-mode/scripts/t3-task.mjs";

const script = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/t3-task.mjs", import.meta.url));

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pstack-t3-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const request = (extra = {}) => ({
  name: "review-a", harness: "grok", model: "grok-4.7", effort: "xhigh", access: "read", brief: "Review the diff.\n", ...extra,
});

test("each registered harness maps to the driver and options T3 Code names it by", () => {
  const targets = {
    claude: t3Task(request({ harness: "claude", model: "claude-opus-5-5", effort: "max" })).target,
    codex: t3Task(request({ harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" })).target,
    grok: t3Task(request()).target,
    agy: t3Task(request({ harness: "agy", model: "gemini-3.8-flash-high", effort: null })).target,
    muse: t3Task(request({ harness: "muse", model: "muse-wonder-full-1.0", effort: "max" })).target,
  };
  expect(targets).toEqual({
    claude: { driverKind: "claudeAgent", model: "claude-opus-5-5", options: { effort: "max" } },
    codex: { driverKind: "codex", model: "gpt-6.1-sol", options: { reasoningEffort: "xhigh" } },
    grok: { driverKind: "grok", model: "grok-4.7", options: { reasoningEffort: "xhigh" } },
    agy: { driverKind: "antigravity", model: "gemini-3.8-flash-high" },
    muse: { driverKind: "muse", model: "muse-wonder-full-1.0", options: { reasoningEffort: "max" } },
  });
});

test("the arguments carry exactly the delegate_task fields, async, with no runtime mode", () => {
  const out = t3Task(request());
  expect(Object.keys(out)).toEqual(["title", "clientRequestId", "mode", "role", "target", "task"]);
  expect(out).toMatchObject({ title: "review-a", mode: "async", role: "review" });
  expect(out.clientRequestId).toMatch(/^pstack-review-a-[0-9a-f]{12}$/);
});

test("options are left out of the target when no effort is given", () => {
  const out = t3Task(request({ effort: null }));
  expect(out.target).toEqual({ driverKind: "grok", model: "grok-4.7" });
  expect("options" in out.target).toBe(false);
});

test("a read child is told to change no file and a write child to change only what the task assigns", () => {
  const reader = t3Task(request({ access: "read" }));
  const writer = t3Task(request({ access: "write" }));
  expect(reader.role).toBe("review");
  expect(reader.task).toContain("- Do not modify any file.\n");
  expect(reader.task).not.toContain("Change only what the task assigns");
  expect(writer.role).toBe("implementation");
  expect(writer.task).toContain("- Change only what the task assigns.\n");
  expect(writer.task).not.toContain("Do not modify any file");
});

test("the task is the brief followed by a protocol that makes the final message the report", () => {
  const { task } = t3Task(request({ brief: "Do the thing.\n\n\n" }));
  expect(task.startsWith("Do the thing.\n\n## Subagent protocol\n")).toBe(true);
  expect(task).toContain(`${join("skills", "poteto-mode", "SKILL.md")} before working`);
  expect(task).toContain("whose first line is exactly QUESTION");
  expect(task).toContain("Never stop at an approval or confirmation prompt");
  expect(task).toContain("your final message is your complete final report");
  expect(task).not.toContain("result.md");
});

test("the request id is stable for a retry and changes with the brief", () => {
  const first = t3Task(request());
  expect(t3Task(request()).clientRequestId).toBe(first.clientRequestId);
  const nextRound = t3Task(request({ brief: "Review the diff.\n\nPrior finding: the loop never exits.\n" }));
  expect(nextRound.clientRequestId).not.toBe(first.clientRequestId);
  expect(nextRound.clientRequestId.startsWith("pstack-review-a-")).toBe(true);
});

test("an effort the harness cannot take is refused, and one it lists is accepted", () => {
  expect(() => t3Task(request({ harness: "agy", model: "gemini-3.8-flash", effort: "high" })))
    .toThrow("agy takes no effort setting; name the effort in the model id (agy:gemini-3.8-flash-high)");
  expect(() => t3Task(request({ effort: "minimal" }))).toThrow("Unsupported grok effort");
  expect(() => t3Task(request({ harness: "muse", model: "m", effort: "minimal" }))).not.toThrow();
});

test("a bad name, harness, access or brief is refused before any arguments are built", () => {
  expect(() => t3Task(request({ name: "Review A" }))).toThrow("--name must match");
  expect(() => t3Task(request({ name: undefined }))).toThrow("--name must match");
  expect(() => t3Task(request({ harness: "nope" }))).toThrow("--harness must be one of");
  expect(() => t3Task(request({ access: "root" }))).toThrow("--access is read or write");
  expect(() => t3Task(request({ brief: "  \n" }))).toThrow("--brief");
});

test("a harness the registry gives no t3 block cannot run in T3 Code", () => {
  const { t3 } = harnesses.codex;
  delete harnesses.codex.t3;
  try {
    expect(() => t3Task(request({ harness: "codex", model: "gpt-6.1-sol", effort: null }))).toThrow("codex has no t3 block");
  } finally {
    harnesses.codex.t3 = t3;
  }
});

test("the command prints the arguments as one JSON object and fails with a message on bad input", () => {
  const brief = join(root, "brief.md");
  writeFileSync(brief, "Review the diff.\n");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const ok = run("--name", "review-a", "--harness", "muse", "--model", "muse-wonder-full-1.0", "--effort", "max", "--access", "write", "--brief", brief);
  expect(ok.status).toBe(0);
  expect(JSON.parse(ok.stdout)).toEqual(t3Task(request({
    harness: "muse", model: "muse-wonder-full-1.0", effort: "max", access: "write", brief: "Review the diff.\n",
  })));
  const bad = run("--name", "review-a", "--harness", "agy", "--model", "gemini-3.8-flash", "--effort", "high", "--brief", brief);
  expect(bad.status).toBe(1);
  expect(bad.stdout).toBe("");
  expect(bad.stderr).toContain("agy takes no effort setting");
  expect(run("--name", "review-a", "--harness", "grok", "--model", "grok-4.7", "--brief", join(root, "missing.md")).stderr)
    .toContain("--brief must name an existing file");
});
