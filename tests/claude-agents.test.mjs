import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProfiles, routesFromSheet } from "../plugins/pstack/skills/poteto-mode/scripts/claude-agents.mjs";

const script = new URL("../plugins/pstack/skills/poteto-mode/scripts/claude-agents.mjs", import.meta.url).pathname;
const sheet = `# pstack model configuration
feature, refactoring: claude-opus-5-5@high
bug-fix: claude-opus-5-5
arena runners: claude-opus-5-5@high, claude-fable-5-1, claude-sonnet-5@low
swarm workers: inherit-parent
effort: claude-fable-5-1 = max
`;
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(text = sheet) {
  const root = mkdtempSync(join(tmpdir(), "pstack-claude-"));
  directories.push(root);
  const mapping = join(root, "pstack-models.md");
  writeFileSync(mapping, text);
  return { mapping, config: join(root, ".claude") };
}

test("routes effort-bearing pairs to generated agents and leaves bare pairs on the Agent model parameter", () => {
  const { routes, profiles } = routesFromSheet(sheet);
  expect(routes.feature).toEqual([{ agent: "pstack-claude-opus-5-5-high", model: "claude-opus-5-5", effort: "high" }]);
  expect(routes.refactoring).toEqual(routes.feature);
  expect(routes["bug-fix"]).toEqual([{ agent: null, model: "claude-opus-5-5", effort: null }]);
  expect(routes["arena runners"]).toEqual([
    { agent: "pstack-claude-opus-5-5-high", model: "claude-opus-5-5", effort: "high" },
    { agent: "pstack-claude-fable-5-1-max", model: "claude-fable-5-1", effort: "max" },
    { agent: "pstack-claude-sonnet-5-low", model: "claude-sonnet-5", effort: "low" },
  ]);
  expect(routes["swarm workers"]).toEqual([{ agent: null, model: "inherit-parent", effort: null }]);
  expect([...profiles.keys()].sort()).toEqual([
    "pstack-claude-fable-5-1-max", "pstack-claude-opus-5-5-high", "pstack-claude-sonnet-5-low",
  ]);
});

test("applies explicit effort to an inherited model through model: inherit", () => {
  const { mapping, config } = fixture("swarm workers: inherit-parent@medium\n");
  const { routes } = installProfiles(mapping, config);
  expect(routes["swarm workers"]).toEqual([{ agent: "pstack-inherit-medium", model: "inherit-parent", effort: "medium" }]);
  expect(readFileSync(join(config, "agents", "pstack-inherit-medium.md"), "utf8"))
    .toContain("name: pstack-inherit-medium\ndescription: Pstack worker routed to inherit at medium effort.");
  expect(readFileSync(join(config, "agents", "pstack-inherit-medium.md"), "utf8")).toContain("\nmodel: inherit\neffort: medium\n");
});

test("rejects an effort Claude Code cannot apply instead of dropping it", () => {
  expect(() => routesFromSheet("feature: claude-opus-5-5@turbo")).toThrow("Unsupported Claude Code effort for feature: turbo");
  expect(() => routesFromSheet("feature: openai/gpt-6@high")).toThrow("Invalid model assignment for feature: openai/gpt-6");
});

test("installs agents with model and effort frontmatter, idempotently, beside unrelated agents", () => {
  const { mapping, config } = fixture();
  mkdirSync(join(config, "agents"), { recursive: true });
  writeFileSync(join(config, "agents", "poteto-agent.md"), "User agent\n");
  installProfiles(mapping, config);
  const path = join(config, "agents", "pstack-claude-opus-5-5-high.md");
  const text = readFileSync(path, "utf8");
  expect(text.startsWith("---\nname: pstack-claude-opus-5-5-high\n")).toBe(true);
  expect(text).toContain("\nmodel: claude-opus-5-5\neffort: high\n---\n");
  expect(JSON.parse(readFileSync(join(config, "pstack-routing.json"), "utf8")).generatedBy).toBe("pstack-claude");
  expect(readFileSync(join(config, "agents", "poteto-agent.md"), "utf8")).toBe("User agent\n");
  installProfiles(mapping, config);
  expect(readFileSync(path, "utf8")).toBe(text);
  installProfiles(mapping, config, { check: true });
});

test("an effort change makes the installed routes stale until reinstalled", () => {
  const { mapping, config } = fixture();
  installProfiles(mapping, config);
  writeFileSync(mapping, sheet.replace("claude-opus-5-5@high\nbug", "claude-opus-5-5@xhigh\nbug"));
  expect(() => installProfiles(mapping, config, { check: true })).toThrow("routing is stale");
  expect(installProfiles(mapping, config).routes.feature[0].agent).toBe("pstack-claude-opus-5-5-xhigh");
});

test("refuses to overwrite an unmanaged agent or an OpenCode routing manifest", () => {
  const { mapping, config } = fixture();
  const agents = join(config, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "pstack-claude-opus-5-5-high.md"), "User-owned agent\n");
  expect(() => installProfiles(mapping, config)).toThrow("Refusing to overwrite unmanaged agent");
  rmSync(join(agents, "pstack-claude-opus-5-5-high.md"));
  writeFileSync(join(config, "pstack-routing.json"), '{"generatedBy":"pstack-opencode"}');
  expect(() => installProfiles(mapping, config)).toThrow("Refusing to overwrite unmanaged routing file");
});

test("the CLI installs and then answers a role", () => {
  const { mapping, config } = fixture();
  const run = (...args) => spawnSync("node", [script, "--mapping", mapping, "--config-dir", config, ...args], { encoding: "utf8" });
  expect(run("--role", "feature").stderr).toContain("routing is stale");
  expect(JSON.parse(run("--install").stdout).status).toBe("installed");
  expect(JSON.parse(run("--role", "arena runners").stdout)[1]).toEqual(
    { agent: "pstack-claude-fable-5-1-max", model: "claude-fable-5-1", effort: "max" });
});
