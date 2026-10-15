import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProfiles, routesFromSheet } from "../plugins/pstack/skills/poteto-mode/scripts/opencode-agents.mjs";

const sheet = `# Model configuration
feature, refactoring: muse-code/muse-spark-1.3
arena runners: openai/gpt-6-astra, muse-code/muse-spark-1.3, muse-code/muse-spark-1.3
swarm workers: inherit-parent

| Model ID | Display name | Variant |
|---|---|---|
| \`muse-code/muse-spark-1.3\` | Spark | \`max\` |
| \`openai/gpt-6-astra\` | Astra | \`max\` |
`;
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pstack-opencode-"));
  directories.push(root);
  const mapping = join(root, "pstack-models.md");
  writeFileSync(mapping, sheet);
  return { root, mapping, config: join(root, "config") };
}

test("resolves role aliases, variants, panel multiplicity and explicit inheritance", () => {
  const { routes, profiles } = routesFromSheet(sheet);
  expect(routes.feature).toEqual([{ agent: "pstack-muse-code-muse-spark-1-3-max", model: "muse-code/muse-spark-1.3", variant: "max" }]);
  expect(routes.refactoring).toEqual(routes.feature);
  expect(routes["arena runners"].map((target) => target.model)).toEqual([
    "openai/gpt-6-astra", "muse-code/muse-spark-1.3", "muse-code/muse-spark-1.3",
  ]);
  expect(routes["swarm workers"]).toEqual([{ agent: "general", model: "inherit-parent" }]);
  expect(profiles.size).toBe(2);
});

test("fails closed on an invalid variant or conflicting role", () => {
  expect(() => routesFromSheet("feature: muse-code/muse-spark-1.3@bad/variant")).toThrow("Invalid reasoning variant");
  expect(() => routesFromSheet(sheet + "\nfeature: openai/gpt-6-astra\n")).toThrow("Conflicting assignment for feature");
  expect(() => routesFromSheet("# Empty sheet")).toThrow("No role assignments");
});

test("installs explicit OpenCode profiles without changing unrelated configuration", () => {
  const { mapping, config } = fixture();
  mkdirSync(config);
  const original = '{"default_agent":"build"}\n';
  writeFileSync(join(config, "opencode.json"), original);
  installProfiles(mapping, config);
  const profile = join(config, "agents", "pstack-muse-code-muse-spark-1-3-max.md");
  const text = readFileSync(profile, "utf8");
  expect(text).toContain("mode: subagent\nmodel: muse-code/muse-spark-1.3#max\n");
  expect(JSON.parse(readFileSync(join(config, "pstack-routing.json"), "utf8")).routes.feature[0].agent)
    .toBe("pstack-muse-code-muse-spark-1-3-max");
  expect(readFileSync(join(config, "opencode.json"), "utf8")).toBe(original);
  installProfiles(mapping, config);
  expect(readFileSync(profile, "utf8")).toBe(text);
  installProfiles(mapping, config, { check: true });
});

test("rejects stale installed routes after the mapping changes", () => {
  const { mapping, config } = fixture();
  installProfiles(mapping, config);
  writeFileSync(mapping, sheet.replace("feature, refactoring: muse-code/muse-spark-1.3", "feature, refactoring: openai/gpt-6-astra"));
  expect(() => installProfiles(mapping, config, { check: true })).toThrow("routing is stale");
  const result = installProfiles(mapping, config);
  expect(result.routes.feature[0].agent).toBe("pstack-openai-gpt-6-astra-max");
});

test("preserves an unmanaged agent rather than overwriting it", () => {
  const { mapping, config } = fixture();
  const agents = join(config, "agents");
  mkdirSync(agents, { recursive: true });
  const path = join(agents, "pstack-muse-code-muse-spark-1-3-max.md");
  writeFileSync(path, "User-owned agent\n");
  expect(() => installProfiles(mapping, config)).toThrow("Refusing to overwrite unmanaged agent");
  expect(readFileSync(path, "utf8")).toBe("User-owned agent\n");
});


test("applies inline and model-wide effort before legacy Muse variants", () => {
  const text = sheet.replace("feature, refactoring: muse-code/muse-spark-1.3", "feature, refactoring: muse-code/muse-spark-1.3@high")
    + "\neffort: muse-code/muse-spark-1.3 = medium\n";
  const { routes, profiles } = routesFromSheet(text);
  expect(routes.feature[0].variant).toBe("high");
  expect(routes["arena runners"].map((target) => target.variant)).toEqual(["max", "medium", "medium"]);
  expect([...profiles.values()]).toContain("muse-code/muse-spark-1.3#high");
});

test("explicit default clears legacy variants and model-wide effort", () => {
  const { routes, profiles } = routesFromSheet(sheet.replace("feature, refactoring: muse-code/muse-spark-1.3", "feature, refactoring: muse-code/muse-spark-1.3@default")
    + "\neffort: muse-code/muse-spark-1.3 = high\n");
  expect(routes.feature[0].variant).toBeNull();
  expect(profiles.get(routes.feature[0].agent)).toBe("muse-code/muse-spark-1.3");
  expect(routesFromSheet("feature: muse-code/muse-spark-1.3").routes.feature[0].variant).toBeNull();
});

test("does not silently drop effort on an inherited model", () => {
  expect(() => routesFromSheet("swarm workers: inherit-parent@high")).toThrow("Cannot apply explicit effort");
});

test("ignores the session hook setting", () => {
  const { routes } = routesFromSheet(sheet + "\nsession hook: off\n");
  expect(routes["session hook"]).toBeUndefined();
  expect(routes.feature[0].model).toBe("muse-code/muse-spark-1.3");
});

test("effort changes make installed Muse profiles stale and reinstall selects the new variant", () => {
  const { mapping, config } = fixture();
  installProfiles(mapping, config);
  writeFileSync(mapping, sheet + "\neffort: muse-code/muse-spark-1.3 = high\n");
  expect(() => installProfiles(mapping, config, { check: true })).toThrow("routing is stale");
  const { routes } = installProfiles(mapping, config);
  const profile = readFileSync(join(config, "agents", `${routes.feature[0].agent}.md`), "utf8");
  expect(profile).toContain("model: muse-code/muse-spark-1.3#high\n");
  installProfiles(mapping, config, { check: true });
});

test("a claude: entry on an OpenCode sheet routes to a foreign target and a bare model stays native", () => {
  const { routes, profiles } = routesFromSheet("feature: claude:claude-opus-5-5@high\nbug-fix: openai/gpt-6-astra\n");
  expect(routes.feature).toEqual([{ agent: null, harness: "claude", model: "claude-opus-5-5", effort: "high", foreign: true }]);
  expect(routes["bug-fix"][0]).toMatchObject({ model: "openai/gpt-6-astra" });
  expect(routes["bug-fix"][0].foreign).toBeUndefined();
  expect([...profiles.keys()].every((agent) => !agent.includes("claude-opus"))).toBe(true);
});
