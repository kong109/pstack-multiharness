import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSheet, parseEntry, resolveRole, userSheet } from "../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs";

test("a panel keeps its order and duplicates, each entry with its own effort", () => {
  expect(resolveRole("arena runners: sonnet@high, opus, sonnet@low", "arena runners")).toEqual([
    { model: "sonnet", effort: "high" }, { model: "opus", effort: null }, { model: "sonnet", effort: "low" },
  ]);
});

test("the default effort line applies to entries without a suffix, across roles and defaults", () => {
  const sheet = "default effort: medium\nfeature, refactoring: opus@xhigh\nbug-fix: opus";
  expect(resolveRole(sheet, "feature, refactoring")).toEqual([{ model: "opus", effort: "xhigh" }]);
  expect(resolveRole(sheet, "bug-fix")).toEqual([{ model: "opus", effort: "medium" }]);
  expect(resolveRole(sheet, "swarm workers", "sonnet")).toEqual([{ model: "sonnet", effort: "medium" }]);
  expect(resolveRole("default effort: session\nbug-fix: opus", "bug-fix")).toEqual([{ model: "opus", effort: null }]);
});

test("aliases omit the model and keep an explicit effort", () => {
  expect(resolveRole("role: auto@high, inherit-parent", "role")).toEqual([
    { model: null, effort: "high" }, { model: null, effort: null },
  ]);
});

test("provider IDs, OpenCode variants, and CRLF survive", () => {
  expect(resolveRole("# config\r\nrole: provider/a@high, provider/a#max\r\n", "role")).toEqual([
    { model: "provider/a", effort: "high" }, { model: "provider/a#max", effort: null },
  ]);
});

test("the old forms fail with the fix in the message", () => {
  expect(() => resolveRole("role: sonnet @xhigh", "role")).toThrow("`sonnet@xhigh`");
  expect(() => resolveRole("role: gpt-6.1-sol->pi @max", "role")).toThrow("`gpt-6.1-sol->pi@max`");
  expect(() => resolveRole("role: codex:gpt-5 @high", "role")).toThrow("`gpt-5->codex@high`");
  expect(() => resolveRole("role: opus @high@low", "role")).toThrow("Invalid model entry: opus@high@low");
  expect(() => resolveRole("role: sonnet\neffort: sonnet = high", "role")).toThrow("default effort");
});

test("malformed or ambiguous settings fail instead of losing effort", () => {
  for (const sheet of ["role: a @", "role: a@high@low", "role: a,", "role: a\nrole: b", "default effort: a b"]) {
    expect(() => resolveRole(sheet, "role", "a")).toThrow();
  }
  expect(() => resolveRole("", "missing")).toThrow();
});

test("CLI emits JSON and does not ignore missing files", () => {
  const script = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const result = run("-", "role", "opus@high");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([{ model: "opus", effort: "high" }]);
  const missing = run("/nonexistent-pstack-sheet.md", "role", "a");
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
});

test("a model runs on its provider's harness, and the native harness is left out", () => {
  expect(resolveRole("role: gpt-6.1-sol@xhigh, opus@high, claude-opus-5-5", "role")).toEqual([
    { harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    { model: "opus", effort: "high" },
    { model: "claude-opus-5-5", effort: null },
  ]);
});

test("->harness names the harness, with the effort after a space or straight after the harness", () => {
  expect(resolveRole("role: gpt-6.1-sol->codex@xhigh, opus->claude@high", "role")).toEqual([
    { harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    { model: "opus", effort: "high" },
  ]);
  expect(parseEntry("muse->pi@max")).toEqual({ model: "muse", harness: "pi", explicitEffort: "max" });
});

test("a provider's harness name stands for that provider's default model", () => {
  expect(resolveRole("role: muse@low, codex, claude@max, grok, agy", "role")).toEqual([
    { harness: "muse", model: "muse-wonder-full-1.0", effort: "low" },
    { harness: "codex", model: "gpt-6.1-sol", effort: null },
    { model: "opus", effort: "max" },
    { harness: "grok", model: "grok-4.7", effort: null },
    { harness: "agy", model: "gemini-3.8-flash", effort: null },
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
  expect(resolveRole("role: muse->pi@max, gpt-6.1-sol->pi, openai-codex/gpt-6-luna->pi@low", "role", undefined, fixture)).toEqual([
    { harness: "pi", model: "muse/muse-wonder-full-1.0", effort: "max" },
    { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: null },
    { harness: "pi", model: "openai-codex/gpt-6-luna", effort: "low" },
  ]);
});

test("a harness that serves no model of that provider fails and names one that does", () => {
  expect(() => resolveRole("role: opus->pi", "role", undefined, fixture)).toThrow("pi runs no Anthropic (Claude Code) models, so it cannot run opus");
  expect(() => resolveRole("role: opus->pi", "role", undefined, fixture)).toThrow("(use opus->claude)");
  expect(() => resolveRole("role: opus->codex", "role")).toThrow("use opus->claude");
  expect(() => resolveRole("role: muse->nope", "role")).toThrow("Unknown harness: nope");
});

test("a model no provider claims stays on the native harness unchanged", () => {
  expect(resolveRole("role: ollama:qwen3:8b, provider/a#max", "role")).toEqual([
    { model: "ollama:qwen3:8b", effort: null }, { model: "provider/a#max", effort: null },
  ]);
});

test("the old harness: prefix fails with the arrow form in the message", () => {
  expect(() => resolveRole("role: codex:gpt-6.1-sol@xhigh", "role")).toThrow("`gpt-6.1-sol->codex@xhigh`");
  expect(() => resolveRole("role: muse:muse-wonder-full-1.0", "role")).toThrow("`muse-wonder-full-1.0->muse`");
});

test("the default effort reaches a harness entry unless that harness takes no effort", () => {
  expect(resolveRole("default effort: high\nrole: gpt-6.1-sol, gemini-3.8-flash, gpt-6.1-sol->opencode", "role")).toEqual([
    { harness: "codex", model: "gpt-6.1-sol", effort: "high" },
    { harness: "agy", model: "gemini-3.8-flash", effort: "high" },
    { harness: "opencode", model: "openai/gpt-6.1-sol", effort: null },
  ]);
});

test("an id that names its effort keeps it, and a second effort on it is refused, since agy rejects the pair", () => {
  expect(resolveRole("default effort: low\nrole: gemini-3.8-flash-high, gemini-3.8-flash-low@session", "role")).toEqual([
    { harness: "agy", model: "gemini-3.8-flash-high", effort: null },
    { harness: "agy", model: "gemini-3.8-flash-low", effort: null },
  ]);
  expect(() => resolveRole("role: gemini-3.8-flash-high@low", "role")).toThrow("write `gemini-3.8-flash@low` instead of `gemini-3.8-flash-high@low`");
  expect(resolveRole("role: gpt-6.1-sol-high@high", "role")).toEqual([{ harness: "codex", model: "gpt-6.1-sol-high", effort: "high" }]);
});

test("a default effort the harness does not list is left off, so that harness runs at its own default", () => {
  expect(resolveRole("default effort: max\nrole: agy, grok, claude, gemini-3.8-flash@high", "role")).toEqual([
    { harness: "agy", model: "gemini-3.8-flash", effort: null },
    { harness: "grok", model: "grok-4.7", effort: null },
    { model: "opus", effort: "max" },
    { harness: "agy", model: "gemini-3.8-flash", effort: "high" },
  ]);
});

test("an arrow entry needs a model, a harness, and at most one effort", () => {
  for (const entry of ["->codex", "auto->codex", "inherit-parent->codex@high", "gpt->", "gpt->Codex", "gpt->codex@", "gpt->codex@low@high", "gpt->codex@low@high"]) {
    expect(() => resolveRole(`role: ${entry}`, "role")).toThrow("Invalid model entry");
  }
});

test("grok, agy and muse model ids keep their dots and dashes", () => {
  expect(resolveRole("role: grok-4.7@xhigh, gemini-3.8-flash-high, muse-wonder-full-1.0@max", "role")).toEqual([
    { harness: "grok", model: "grok-4.7", effort: "xhigh" },
    { harness: "agy", model: "gemini-3.8-flash-high", effort: null },
    { harness: "muse", model: "muse-wonder-full-1.0", effort: "max" },
  ]);
});

test("a provider/model id or an open-weight model runs on any harness, for an operator with an API key", () => {
  expect(resolveRole("role: anthropic/claude-opus-5-5->opencode@high, muse-code/muse-wonder-full-1.0->omp, kimi-k3->opencode", "role")).toEqual([
    { harness: "opencode", model: "anthropic/claude-opus-5-5", effort: "high" },
    { harness: "omp", model: "muse-code/muse-wonder-full-1.0", effort: null },
    { harness: "opencode", model: "kimi-k3", effort: null },
  ]);
  expect(() => resolveRole("role: muse->omp", "role")).toThrow("with an API key, write the id omp takes, as in `provider/muse-wonder-full-1.0->omp`");
  expect(() => resolveRole("role: muse->agy", "role")).toThrow(/^agy runs no Meta \(Muse\) models, so it cannot run muse-wonder-full-1.0 \(use muse->muse\)$/);
});

test("pi, omp and opencode give each provider's model its own id prefix", () => {
  expect(resolveRole("role: gpt-6.1-sol->pi@low, gpt-6.1-sol->omp@max, gpt-6.1-sol->opencode", "role")).toEqual([
    { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "low" },
    { harness: "omp", model: "openai-codex/gpt-6.1-sol", effort: "max" },
    { harness: "opencode", model: "openai/gpt-6.1-sol", effort: null },
  ]);
  expect(() => resolveRole("role: muse->pi", "role")).toThrow("pi runs no Meta (Muse) models, so it cannot run muse-wonder-full-1.0 (use muse->muse)");
  for (const [entry, own] of [["muse->omp", "muse"], ["opus->omp", "claude"], ["grok->omp", "grok"], ["gemini-3.8-flash-high->opencode", "agy"]]) {
    expect(() => resolveRole(`role: ${entry}`, "role")).toThrow(`(use ${entry.split("->")[0]}->${own})`);
  }
});

test("the migration turns old harness prefixes into the arrow form and leaves everything else as written", async () => {
  const { migrateText } = await import("../plugins/pstack/skills/poteto-mode/scripts/migrate-sheet.mjs");
  const before = "# sheet\r\nfeature: codex:gpt-6.1-sol@xhigh, opus@high\r\narena runners: claude:opus, muse:muse-wonder-full-1.0@low,agy:gemini-3.8-flash-low\r\nswarm workers: ollama:qwen3:8b\r\ndefault effort: high\r\n";
  const after = migrateText(before);
  expect(after).toBe("# sheet\r\nfeature: gpt-6.1-sol@xhigh, opus@high\r\narena runners: opus, muse-wonder-full-1.0@low,gemini-3.8-flash@low\r\nswarm workers: ollama:qwen3:8b\r\ndefault effort: high\r\n");
  expect(migrateText("role: codex:my-custom@low")).toBe("role: my-custom->codex@low");
  expect(migrateText("role: muse:muse-wonder-full-1.0@max, claude-opus-5-5@high, muse->omp@max")).toBe("role: muse-wonder-full-1.0@max, claude-opus-5-5@high, muse->omp@max");
  expect(migrateText("role: opus @xhigh, gpt-6.1-sol->pi\t@max, sonnet @minimal\ncontact: ping @kong109")).toBe("role: opus@xhigh, gpt-6.1-sol->pi@max, sonnet@minimal\ncontact: ping @kong109");
  expect(migrateText(migrateText("role: opus @xhigh, gemini-3.8-flash-high"))).toBe("role: opus@xhigh, gemini-3.8-flash@high");
  expect(migrateText("contact: me@example.com")).toBe("contact: me@example.com");
  expect(migrateText("role: gemini-3.8-flash-high, gemini-4-argon-medium->agy, gemini-3.8-flash-high@low, gemini-3.8-flash-highest")).toBe("role: gemini-3.8-flash@high, gemini-4-argon->agy@medium, gemini-3.8-flash@low, gemini-3.8-flash-highest");
  expect(migrateText("role: gemini-3.8-flash-low@session, gemini-3.8-flash-low->agy@session")).toBe("role: gemini-3.8-flash@low, gemini-3.8-flash->agy@low");
  expect(migrateText("role: gpt-6.1-sol-high->opencode, opus-max")).toBe("role: gpt-6.1-sol-high->opencode, opus-max");
  for (const role of ["feature", "arena runners", "swarm workers"]) expect(() => resolveRole(after, role)).not.toThrow();
});

test("the session's own harness is the one left out, and a session outside the registry keeps bare entries native", () => {
  const sheet = "arena runners: opus@high, opus->claude, gpt-6.1-sol@xhigh, ollama:qwen3:8b";
  expect(resolveRole(sheet, "arena runners", undefined, { session: "codex" })).toEqual([
    { harness: "claude", model: "opus", effort: "high" },
    { harness: "claude", model: "opus", effort: null },
    { model: "gpt-6.1-sol", effort: "xhigh" },
    { model: "ollama:qwen3:8b", effort: null },
  ]);
  expect(resolveRole("r: gpt-5.4, gemini-2.5-pro@high, auto, grok-4.7->grok", "r", undefined, { session: "copilot" })).toEqual([
    { model: "gpt-5.4", effort: null },
    { model: "gemini-2.5-pro", effort: "high" },
    { model: null, effort: null },
    { harness: "grok", model: "grok-4.7", effort: null },
  ]);
  expect(() => resolveRole("r: codex:gpt-5->pi", "r")).toThrow("name the harness after the model, as in `gpt-5->pi`");
});

test("the migration keeps an arrow whose harness no provider of that model owns, so the entry runs where it did in any session", async () => {
  const { migrateText } = await import("../plugins/pstack/skills/poteto-mode/scripts/migrate-sheet.mjs");
  expect(migrateText("role: claude:local-thing, claude:opus@high")).toBe("role: local-thing->claude, opus@high");
  expect(resolveRole(migrateText("role: claude:local-thing, claude:opus@high"), "role", undefined, { session: "codex" })).toEqual([
    { harness: "claude", model: "local-thing", effort: null },
    { harness: "claude", model: "opus", effort: "high" },
  ]);
});

test("an entry cut short by an unquoted -> in a shell is refused with the reason", () => {
  for (const cut of ["muse-", "gpt-6.1-sol-@high"]) expect(() => parseEntry(cut)).toThrow("the shell read `->` as a redirect, so quote the entry");
  expect(parseEntry("muse->omp")).toMatchObject({ model: "muse", harness: "omp" });
});

test("the active sheet is the project's, then the main checkout's for a linked worktree, then the runtime's user sheet", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "find-sheet-")));
  try {
    const home = join(base, "home");
    const repo = join(base, "repo");
    const tree = join(base, "tree");
    const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(repo, "sub"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "worktree", "add", "-q", tree);
    const user = join(home, ".codex", "pstack-models.md");
    const find = (cwd, session = "codex") => findSheet({ session, cwd, env: {}, home });
    expect(find(repo)).toMatchObject({ path: null, scope: null });
    writeFileSync(user, "bug-fix: gpt-6.1-sol\n");
    expect(find(tree)).toMatchObject({ path: user, scope: "user" });
    expect(find(tree).checked).toEqual([join(tree, ".pstack", "models.md"), join(repo, ".pstack", "models.md"), user]);
    mkdirSync(join(repo, ".pstack"));
    writeFileSync(join(repo, ".pstack", "models.md"), "bug-fix: opus@high\n");
    expect(find(join(repo, "sub"))).toMatchObject({ path: join(repo, ".pstack", "models.md"), scope: "project" });
    expect(find(tree)).toMatchObject({ path: join(repo, ".pstack", "models.md"), scope: "project" });
    mkdirSync(join(tree, ".pstack"));
    writeFileSync(join(tree, ".pstack", "models.md"), "bug-fix: fable\n");
    expect(find(tree).path).toBe(join(tree, ".pstack", "models.md"));
    expect(find(base, "claude")).toMatchObject({ path: null, checked: [join(base, ".pstack", "models.md"), join(home, ".claude", "pstack-models.md")] });

    const script = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs", import.meta.url));
    const run = (...args) => spawnSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: "" } });
    const resolved = run("--session", "codex", "--active", "--cwd", repo, "bug-fix", "gpt-6.1-sol");
    expect(JSON.parse(resolved.stdout)).toEqual([{ harness: "claude", model: "opus", effort: "high" }]);
    expect(resolved.stderr.trim()).toBe(`sheet: ${join(repo, ".pstack", "models.md")} (project)`);
    expect(JSON.parse(run("--session", "codex", "--active", "--cwd", repo).stdout).scope).toBe("project");
    expect(run("--cwd", repo, "sheet.md", "bug-fix").status).toBe(1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("each runtime's user sheet follows the variable that moves its config folder", () => {
  expect(userSheet("claude", { env: { CLAUDE_CONFIG_DIR: "/cfg" }, home: "/h" })).toBe(join("/cfg", "pstack-models.md"));
  expect(userSheet("codex", { env: {}, home: "/h" })).toBe(join("/h", ".codex", "pstack-models.md"));
  expect(userSheet("muse", { env: { XDG_CONFIG_HOME: "/x" }, home: "/h" })).toBe(join("/x", "muse", "pstack-models.md"));
  expect(userSheet("agy", { env: {}, home: "/h" })).toBe(join("/h", ".gemini/config", "pstack-models.md"));
  expect(() => userSheet("nope")).toThrow("No user sheet path is known for nope");
});
