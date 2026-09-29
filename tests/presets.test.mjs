import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPreset, listPresets, presetDirectory, savePreset, snapshot } from "../plugins/pstack/skills/pstack-preset/scripts/presets.mjs";
import { routesFromSheet } from "../plugins/pstack/skills/poteto-mode/scripts/opencode-agents.mjs";
import { resolveRole } from "../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs";

const fixtures = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pstack-presets-"));
  fixtures.push(root);
  const source = join(root, "source.md");
  writeFileSync(source, "# local notes\n\nUnrelated instructions.\n\narena runners: a@high, b, a@low\neffort: b = medium\n");
  return { root, source };
}

test("save and apply preserve resolved effort and panel entries without carrying prose", () => {
  const { root, source } = fixture();
  const dir = presetDirectory("user", root, root);
  expect(listPresets(dir)).toEqual([]);
  const saved = savePreset(dir, "daily", source);
  expect(listPresets(dir)).toEqual(["daily"]);
  const target = join(root, "project", ".pstack", "models.md");
  applyPreset(dir, "daily", target);
  const applied = readFileSync(target, "utf8");
  expect(applied).not.toContain("Unrelated instructions");
  expect(resolveRole(applied, "arena runners")).toEqual(resolveRole(readFileSync(source, "utf8"), "arena runners"));
  writeFileSync(target, "arena runners: changed");
  expect(readFileSync(saved, "utf8")).not.toContain("changed");
});

test("same-name presets in both scopes remain independent", () => {
  const { root, source } = fixture();
  const user = presetDirectory("user", root, root);
  const project = presetDirectory("project", root, root);
  savePreset(user, "daily", source);
  writeFileSync(source, "bug-fix: auto@high\n");
  savePreset(project, "daily", source);
  expect(listPresets(user)).toEqual(["daily"]);
  expect(listPresets(project)).toEqual(["daily"]);
  const target = join(root, "user-models.md");
  applyPreset(project, "daily", target);
  expect(resolveRole(readFileSync(target, "utf8"), "bug-fix")).toEqual([{ model: null, effort: "high" }]);
});

test("the CLI lists, shows, and applies an existing dotted version preset", () => {
  const { root } = fixture();
  const directory = presetDirectory("project", root);
  mkdirSync(directory, { recursive: true });
  const sheet = "# pstack model configuration\n\nbug-fix: gpt-6.1-sol@high\n";
  writeFileSync(join(directory, "openai-6.1.md"), sheet);
  const helper = join(import.meta.dir, "../plugins/pstack/skills/pstack-preset/scripts/presets.mjs");
  const run = (...args) => spawnSync("node", [helper, ...args], { cwd: root, encoding: "utf8" });
  const listed = run("list", "project");
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual(["openai-6.1"]);
  const shown = run("show", "project", "openai-6.1");
  expect(shown.stderr).toBe("");
  expect(shown.status).toBe(0);
  expect(shown.stdout.trim()).toBe(sheet.trim());
  const target = join(root, "applied.md");
  const applied = run("apply", "project", "openai-6.1", target);
  expect(applied.stderr).toBe("");
  expect(applied.status).toBe(0);
  expect(readFileSync(target, "utf8")).toBe(sheet);
  for (const name of ["../escape", "con.1", "a:b"]) {
    const rejected = run("show", "project", name);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("portable lowercase");
  }
});

test("save accepts dotted names and the existing maximum name length", () => {
  const { root, source } = fixture();
  const directory = presetDirectory("user", root, root);
  const names = ["openai-6.1", "release.1-beta.2", "x".repeat(64)];
  for (const name of names) savePreset(directory, name, source);
  expect(listPresets(directory)).toEqual(names.sort());
});

test("replacement is explicit and invalid source leaves existing data intact", () => {
  const { root, source } = fixture();
  const saved = savePreset(root, "daily", source);
  const previous = readFileSync(saved, "utf8");
  expect(() => savePreset(root, "daily", source)).toThrow();
  expect(() => applyPreset(root, "daily", source)).toThrow();
  writeFileSync(source, "bug-fix: a@\n");
  expect(() => savePreset(root, "daily", source, true)).toThrow();
  expect(readFileSync(saved, "utf8")).toBe(previous);
  writeFileSync(source, "bug-fix: b@default\neffort: b = high\n");
  savePreset(root, "daily", source, true);
  applyPreset(root, "daily", source, true);
  expect(resolveRole(readFileSync(source, "utf8"), "bug-fix")).toEqual([{ model: "b", effort: null }]);
});

test("unsafe names, empty sheets, duplicate roles, and bad effort fail", () => {
  const { root, source } = fixture();
  for (const name of [
    "../escape", "a/b", "a\\b", ".", "..", ".hidden", "trailing.", "a..b", "a.-b", "a-.b", "a--b",
    "CON", "nul", "con.1", "prn.1", "aux.1", "nul.1", "com0.1", "com9.1", "lpt0.1", "lpt9.1",
    "a b", "a:b", "a?b", "a*b", "a|b", "a<b", "a>b", 'a"b', "café", "x".repeat(65),
  ]) {
    expect(() => savePreset(root, name, source)).toThrow();
    expect(() => applyPreset(root, name, source, true)).toThrow("portable lowercase");
  }
  for (const sheet of ["# notes only", "role: a\nrole: b", "role: a\neffort: a =", "role: a\neffort: a = high\neffort: a = low"]) {
    expect(() => snapshot(sheet)).toThrow();
  }
  expect(() => presetDirectory("invalid", root, root)).toThrow();
  expect(() => applyPreset(root, "missing", source, true)).toThrow();
});


test("saving and applying a legacy Muse preset retains the actual model and effort routes", () => {
  const { root, source } = fixture();
  const legacy = "feature, refactoring: muse-code/muse-spark-1.3\r\n" +
    "arena runners: muse-code/muse-spark-1.3@high, muse-code/muse-spark-1.3\r\n" +
    "| `muse-code/muse-spark-1.3` | Spark | `max` |\r\n";
  writeFileSync(source, legacy);
  const directory = presetDirectory("user", root, root);
  savePreset(directory, "muse", source);
  const target = join(root, ".pstack", "models.md");
  applyPreset(directory, "muse", target);
  const applied = readFileSync(target, "utf8");
  expect(applied).toContain("effort: muse-code/muse-spark-1.3 = max");
  expect(routesFromSheet(applied).routes).toEqual(routesFromSheet(legacy).routes);
  expect(resolveRole(applied, "feature, refactoring")).toEqual([{ model: "muse-code/muse-spark-1.3", effort: "max" }]);
});
