import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEntry, resolveRole } from "../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs";

test("existing sheets preserve panel order and apply model-wide effort", () => {
  expect(resolveRole("arena runners: a, b, a\neffort: b = medium", "arena runners")).toEqual([
    { model: "a", effort: null }, { model: "b", effort: "medium" }, { model: "a", effort: null },
  ]);
});

test("per-role effort overrides the model default without affecting other roles", () => {
  const sheet = "feature, refactoring: a@high\nbug-fix: a\neffort: a = medium";
  expect(resolveRole(sheet, "feature, refactoring")).toEqual([{ model: "a", effort: "high" }]);
  expect(resolveRole(sheet, "bug-fix")).toEqual([{ model: "a", effort: "medium" }]);
  expect(resolveRole(sheet, "swarm workers", "a")).toEqual([{ model: "a", effort: "medium" }]);
});

test("explicit default clears effort and aliases retain explicit effort", () => {
  expect(resolveRole("role: a@default, auto@high, inherit-parent\neffort: a = medium", "role")).toEqual([
    { model: "a", effort: null }, { model: null, effort: "high" }, { model: null, effort: null },
  ]);
});

test("provider IDs, CRLF, and repeated models with different effort survive", () => {
  expect(resolveRole("# config\r\nrole: provider/a@high, provider/a@low\r\n", "role")).toEqual([
    { model: "provider/a", effort: "high" }, { model: "provider/a", effort: "low" },
  ]);
});

test("malformed or ambiguous settings fail instead of losing effort", () => {
  for (const sheet of ["role: a@", "role: a@high@low", "role: a,", "role: a\nrole: b",
    "effort: a medium", "effort: a = high\neffort: a = low"]) {
    expect(() => resolveRole(sheet, "role", "a")).toThrow();
  }
  expect(() => resolveRole("", "missing")).toThrow();
});

test("CLI emits JSON and does not ignore missing files", () => {
  const script = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const result = run("-", "role", "a@high");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([{ model: "a", effort: "high" }]);
  const missing = run("/nonexistent-pstack-sheet.md", "role", "a");
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
});

test("a registered harness prefix names another harness and keeps the model and effort", () => {
  expect(resolveRole("role: codex:gpt-6.1-sol@xhigh, claude-opus-5-5@high", "role")).toEqual([
    { harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    { model: "claude-opus-5-5", effort: "high" },
  ]);
  expect(parseEntry("claude:claude-opus-5-5")).toEqual({ harness: "claude", model: "claude-opus-5-5", explicitEffort: undefined });
});

test("a prefix that is not a registered harness stays part of the model id", () => {
  expect(resolveRole("role: ollama:qwen3:8b", "role")).toEqual([{ model: "ollama:qwen3:8b", effort: null }]);
});

test("model-wide effort applies to a harness entry by bare or qualified model", () => {
  const sheet = "role: codex:gpt-6.1-sol, codex:gpt-6.1-luna\neffort: gpt-6.1-sol = high\neffort: codex:gpt-6.1-luna = low";
  expect(resolveRole(sheet, "role")).toEqual([
    { harness: "codex", model: "gpt-6.1-sol", effort: "high" },
    { harness: "codex", model: "gpt-6.1-luna", effort: "low" },
  ]);
});

test("a harness entry needs a concrete model", () => {
  for (const entry of ["codex:", "codex:auto", "codex:inherit-parent@high"]) {
    expect(() => resolveRole(`role: ${entry}`, "role")).toThrow("Invalid model entry");
  }
});

test("grok, agy and muse are registered harnesses, and the model id keeps its dots and dashes", () => {
  expect(resolveRole("role: grok:grok-4.7@xhigh, agy:gemini-3.8-flash-high, muse:muse-wonder-full-1.0@max", "role")).toEqual([
    { harness: "grok", model: "grok-4.7", effort: "xhigh" },
    { harness: "agy", model: "gemini-3.8-flash-high", effort: null },
    { harness: "muse", model: "muse-wonder-full-1.0", effort: "max" },
  ]);
});
