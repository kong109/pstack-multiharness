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

test("a model runs on its provider's harness, and the native harness is left out", () => {
  expect(resolveRole("role: gpt-6.1-sol @xhigh, opus @high, claude-opus-5-5", "role")).toEqual([
    { harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    { model: "opus", effort: "high" },
    { model: "claude-opus-5-5", effort: null },
  ]);
});

test("->harness names the harness, with the effort after a space or straight after the harness", () => {
  expect(resolveRole("role: gpt-6.1-sol->codex @xhigh, opus->claude@high", "role")).toEqual([
    { harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    { model: "opus", effort: "high" },
  ]);
  expect(parseEntry("muse->pi@max")).toEqual({ model: "muse", harness: "pi", explicitEffort: "max" });
});

test("a provider's harness name stands for that provider's default model", () => {
  expect(resolveRole("role: muse @low, codex, claude @max, grok, agy", "role")).toEqual([
    { harness: "muse", model: "muse-wonder-full-1.0", effort: "low" },
    { harness: "codex", model: "gpt-6.1-sol", effort: null },
    { model: "opus", effort: "max" },
    { harness: "grok", model: "grok-4.7", effort: null },
    { harness: "agy", model: "gemini-3.8-flash-high", effort: null },
  ]);
});

const fixture = {
  harnesses: {
    claude: { effort: ["--effort", "{effort}"], providers: { anthropic: "{model}" } },
    muse: { effort: ["--reasoning-effort", "{effort}"], providers: { meta: "{model}" } },
    pi: { effort: ["--thinking", "{effort}"], providers: { meta: "muse/{model}", openai: "openai-codex/{model}" } },
  },
};

test("a multi-provider harness gets the model id in its own provider namespace", () => {
  expect(resolveRole("role: muse->pi@max, gpt-6.1-sol->pi, openai-codex/gpt-6-luna->pi @low", "role", undefined, fixture)).toEqual([
    { harness: "pi", model: "muse/muse-wonder-full-1.0", effort: "max" },
    { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: null },
    { harness: "pi", model: "openai-codex/gpt-6-luna", effort: "low" },
  ]);
});

test("a harness that serves no model of that provider fails and names one that does", () => {
  expect(() => resolveRole("role: opus->pi", "role", undefined, fixture)).toThrow("pi runs no Anthropic (Claude Code) models, so it cannot run opus (use opus->claude)");
  expect(() => resolveRole("role: opus->codex", "role")).toThrow("use opus->claude");
  expect(() => resolveRole("role: muse->nope", "role")).toThrow("Unknown harness: nope");
});

test("a model no provider claims stays on the native harness unchanged", () => {
  expect(resolveRole("role: ollama:qwen3:8b, provider/a#max", "role")).toEqual([
    { model: "ollama:qwen3:8b", effort: null }, { model: "provider/a#max", effort: null },
  ]);
});

test("the old harness: prefix fails with the arrow form in the message", () => {
  expect(() => resolveRole("role: codex:gpt-6.1-sol @xhigh", "role")).toThrow("`gpt-6.1-sol->codex @xhigh`");
  expect(() => resolveRole("role: muse:muse-wonder-full-1.0", "role")).toThrow("`muse-wonder-full-1.0->muse`");
});

test("the default effort reaches a harness entry unless that harness takes no effort", () => {
  expect(resolveRole("default effort: high\nrole: gpt-6.1-sol, gemini-3.8-flash-low", "role")).toEqual([
    { harness: "codex", model: "gpt-6.1-sol", effort: "high" },
    { harness: "agy", model: "gemini-3.8-flash-low", effort: null },
  ]);
});

test("an arrow entry needs a model, a harness, and at most one effort", () => {
  for (const entry of ["->codex", "auto->codex", "inherit-parent->codex @high", "gpt->", "gpt->Codex", "gpt->codex@", "gpt->codex@low @high", "gpt->codex@low@high"]) {
    expect(() => resolveRole(`role: ${entry}`, "role")).toThrow("Invalid model entry");
  }
});

test("grok, agy and muse model ids keep their dots and dashes", () => {
  expect(resolveRole("role: grok-4.7 @xhigh, gemini-3.8-flash-high, muse-wonder-full-1.0 @max", "role")).toEqual([
    { harness: "grok", model: "grok-4.7", effort: "xhigh" },
    { harness: "agy", model: "gemini-3.8-flash-high", effort: null },
    { harness: "muse", model: "muse-wonder-full-1.0", effort: "max" },
  ]);
});
