import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEntry, resolveRole } from "../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs";

test("a panel keeps its order and duplicates, each entry with its own effort", () => {
  expect(resolveRole("arena runners: sonnet @high, opus, sonnet @low", "arena runners")).toEqual([
    { model: "sonnet", effort: "high" }, { model: "opus", effort: null }, { model: "sonnet", effort: "low" },
  ]);
});

test("the default effort line applies to entries without a suffix, across roles and defaults", () => {
  const sheet = "default effort: medium\nfeature, refactoring: opus @xhigh\nbug-fix: opus";
  expect(resolveRole(sheet, "feature, refactoring")).toEqual([{ model: "opus", effort: "xhigh" }]);
  expect(resolveRole(sheet, "bug-fix")).toEqual([{ model: "opus", effort: "medium" }]);
  expect(resolveRole(sheet, "swarm workers", "sonnet")).toEqual([{ model: "sonnet", effort: "medium" }]);
  expect(resolveRole("default effort: session\nbug-fix: opus", "bug-fix")).toEqual([{ model: "opus", effort: null }]);
});

test("aliases omit the model and keep an explicit effort", () => {
  expect(resolveRole("role: auto @high, inherit-parent", "role")).toEqual([
    { model: null, effort: "high" }, { model: null, effort: null },
  ]);
});

test("provider IDs, OpenCode variants, and CRLF survive", () => {
  expect(resolveRole("# config\r\nrole: provider/a @high, provider/a#max\r\n", "role")).toEqual([
    { model: "provider/a", effort: "high" }, { model: "provider/a#max", effort: null },
  ]);
});

test("the old forms fail with the fix in the message", () => {
  expect(() => resolveRole("role: sonnet@xhigh", "role")).toThrow("`sonnet @xhigh`");
  expect(() => resolveRole("role: sonnet\neffort: sonnet = high", "role")).toThrow("default effort");
});

test("malformed or ambiguous settings fail instead of losing effort", () => {
  for (const sheet of ["role: a @", "role: a @high@low", "role: a,", "role: a\nrole: b", "default effort: a b"]) {
    expect(() => resolveRole(sheet, "role", "a")).toThrow();
  }
  expect(() => resolveRole("", "missing")).toThrow();
});

test("CLI emits JSON and does not ignore missing files", () => {
  const script = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const result = run("-", "role", "opus @high");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([{ model: "opus", effort: "high" }]);
  const missing = run("/nonexistent-pstack-sheet.md", "role", "a");
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
});

test("a registered harness prefix names another harness and keeps the model and effort", () => {
  expect(resolveRole("role: codex:gpt-6.1-sol @xhigh, opus @high", "role")).toEqual([
    { harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    { model: "opus", effort: "high" },
  ]);
  expect(parseEntry("claude:opus")).toEqual({ harness: "claude", model: "opus", explicitEffort: undefined });
});

test("a prefix that is not a registered harness stays part of the model id", () => {
  expect(resolveRole("role: ollama:qwen3:8b", "role")).toEqual([{ model: "ollama:qwen3:8b", effort: null }]);
});

test("the default effort reaches a harness entry unless that harness takes no effort", () => {
  expect(resolveRole("default effort: high\nrole: codex:gpt-6.1-sol, agy:gemini-3.8-flash-low", "role")).toEqual([
    { harness: "codex", model: "gpt-6.1-sol", effort: "high" },
    { harness: "agy", model: "gemini-3.8-flash-low", effort: null },
  ]);
});

test("a harness entry needs a concrete model", () => {
  for (const entry of ["codex:", "codex:auto", "codex:inherit-parent @high"]) {
    expect(() => resolveRole(`role: ${entry}`, "role")).toThrow("Invalid model entry");
  }
});

test("grok, agy and muse are registered harnesses, and the model id keeps its dots and dashes", () => {
  expect(resolveRole("role: grok:grok-4.7 @xhigh, agy:gemini-3.8-flash-high, muse:muse-wonder-full-1.0 @max", "role")).toEqual([
    { harness: "grok", model: "grok-4.7", effort: "xhigh" },
    { harness: "agy", model: "gemini-3.8-flash-high", effort: null },
    { harness: "muse", model: "muse-wonder-full-1.0", effort: "max" },
  ]);
});
