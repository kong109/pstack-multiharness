import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { foreignTarget } from "../plugins/pstack/skills/poteto-mode/scripts/foreign-launch.mjs";
import { harnesses, resolveRole } from "../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs";
import { apply, parseMessage, planApply } from "../plugins/pstack/skills/pstack-effort/scripts/apply.mjs";
import { buildProviders, codexModels, readPresets } from "../plugins/pstack/skills/pstack-effort/scripts/render.mjs";
import { parseSheet, slotText } from "../plugins/pstack/skills/pstack-effort/scripts/sheet.mjs";

const render = fileURLToPath(new URL("../plugins/pstack/skills/pstack-effort/scripts/render.mjs", import.meta.url));
const providersJson = JSON.parse(readFileSync(new URL("../plugins/pstack/skills/pstack-effort/providers.json", import.meta.url), "utf8"));

const sheet = `# pstack model configuration
Roles below are edited by the page.

feature: opus @high
arena runners: opus @xhigh, codex:gpt-6.1-sol @xhigh
swarm workers: inherit-parent
why synthesizer: claude:opus @medium
default effort: max
session hook: off
`;

const pageSheet = sheet.replace("default effort:", "reflect tooling: ollama:qwen3:8b @high\ndefault effort:");

const codexCache = {
  models: [
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }] },
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
    { slug: "gpt-5-hidden", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
  ],
};

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "pstack-effort-"));
  directories.push(directory);
  return directory;
};

test("parses role lines with harness prefixes and leaves everything else alone", () => {
  const { lines, roles } = parseSheet(pageSheet);
  expect(roles.map((r) => r.role)).toEqual(["feature", "arena runners", "swarm workers", "why synthesizer", "reflect tooling"]);
  expect(roles[1]).toEqual({
    role: "arena runners", line: lines.indexOf("arena runners: opus @xhigh, codex:gpt-6.1-sol @xhigh"),
    slots: [{ harness: "", model: "opus", effort: "xhigh" }, { harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" }],
  });
  expect(roles[3].slots[0].harness).toBe("claude");
  expect(roles[4].slots[0]).toEqual({ harness: "", model: "ollama:qwen3:8b", effort: "high" });
  expect(roles.flatMap((r) => r.slots.map(slotText))).toContain("codex:gpt-6.1-sol @xhigh");
});

test("skips a line with an entry it cannot parse", () => {
  expect(parseSheet("feature: codex:auto\nbug-fix: opus\n").roles.map((r) => r.role)).toEqual(["bug-fix"]);
});

test("reads the OpenAI list from the Codex model cache and ignores hidden models", () => {
  const home = scratch();
  expect(codexModels(home)).toBeNull();
  writeFileSync(join(home, "models_cache.json"), JSON.stringify(codexCache));
  expect(codexModels(home)).toEqual([
    { slug: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "high", "ultra"] },
    { slug: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "medium"] },
  ]);
});

test("builds provider lists from the catalog, the available Claude models and the Codex cache", () => {
  const [anthropic, openai] = buildProviders({ providers: providersJson.providers, available: ["opus", "extra"], codex: null });
  expect(anthropic.models.map((m) => m.slug)).toContain("extra");
  expect(anthropic.models.filter((m) => m.slug === "opus")).toHaveLength(1);
  expect(anthropic.models[0].efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(openai.models.map((m) => m.slug)).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);

  const withCache = buildProviders({ providers: providersJson.providers, available: [], codex: codexModels(cacheHome()) });
  expect(withCache[1].models.find((m) => m.slug === "gpt-6.1-sol").efforts).toEqual(["low", "high", "ultra"]);
});

function cacheHome() {
  const home = scratch();
  writeFileSync(join(home, "models_cache.json"), JSON.stringify(codexCache));
  return home;
}

function renderPage(text, root = scratch()) {
  const sheetPath = join(root, "pstack-models.md");
  const out = join(root, "page.html");
  writeFileSync(sheetPath, text);
  const home = join(root, "home");
  const run = spawnSync(process.execPath, [render, "--sheet", sheetPath, "--out", out, "--scope", "user", "--project-root", join(root, "project")], {
    encoding: "utf8", env: { ...process.env, CODEX_HOME: cacheHome(), HOME: home, USERPROFILE: home },
  });
  expect(run.status).toBe(0);
  return { html: readFileSync(out, "utf8"), sheetPath, root };
}

test("renders the sheet into the page with escaped data and no placeholder left", () => {
  const { html } = renderPage(`${sheet}note: </script><b>\n`);
  expect(html).not.toContain("/*__PSTACK_DATA__*/");
  expect(html).not.toContain("__SCRIPT__");
  expect(html).not.toContain("</script><b>");
  expect(html).toContain("codex:gpt-6.1-sol @xhigh");
});

class Node {
  constructor(tag) { Object.assign(this, { tag, attrs: {}, children: [], listeners: {}, text: "", value: "", checked: false, selected: false }); }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === "value") this.value = String(value); }
  append(...kids) { this.children.push(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { (this.listeners[type] ?? []).forEach((fn) => fn({})); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  buttons(label) {
    const own = this.tag === "button" && this.text === label ? [this] : [];
    return own.concat(...this.children.map((c) => c.buttons(label)));
  }
  find(id) {
    if (this.attrs.id === id) return this;
    for (const child of this.children) { const hit = child.find(id); if (hit) return hit; }
    return null;
  }
}

function mount(text, store = new Map(), dir = scratch()) {
  const { html } = renderPage(text, dir);
  const script = /<script>\r?\n([\s\S]*)\r?\n<\/script>/.exec(html)[1];
  const root = new Node("root");
  for (const id of ["meta", "legend", "preset", "preset-note", "roles", "changes", "out", "reset", "copy", "status"]) { const n = new Node("div"); n.setAttribute("id", id); root.append(n); }
  const context = {
    document: { getElementById: (id) => root.find(id), createElement: (tag) => new Node(tag), createTextNode: (t) => Object.assign(new Node("#text"), { text: t }) },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    navigator: {}, window: {},
  };
  runInNewContext(script, context);
  const at = (id) => { const n = root.find(id); if (!n) throw new Error(`no element ${id}`); return n; };
  const choose = (id, value) => { const n = at(id); n.value = value; n.fire("change"); };
  const tick = (id) => { const n = at(id); n.checked = !n.checked; n.fire("change"); };
  const message = () => at("out").textContent;
  const role = (name) => parseMessage(message()).next.split("\n").find((l) => l.startsWith(`${name}:`));
  const roleIndex = (name) => parseSheet(text).roles.findIndex((r) => r.role === name);
  const efforts = (ri, si) => ["low", "medium", "high", "xhigh", "max", "ultra"].filter((e) => root.find(`e-${ri}-${si}-${e}`));
  const press = (label, nth = 0) => root.buttons(label)[nth].fire("click");
  const rolesText = () => at("roles").textContent;
  const options = (id) => at(id).children.map((c) => c.text);
  return { options, at, choose, tick, message, role, roleIndex, efforts, press, rolesText, has: (id) => Boolean(root.find(id)), click: (id) => at(id).fire("click"), next: () => parseMessage(message()).next };
}

test("the page writes an unchanged sheet back byte for byte", () => {
  const page = mount(pageSheet);
  expect(page.message()).toContain("changes: 0");
  expect(page.next()).toBe(pageSheet);
});

test("switching a slot to another harness prefixes the entry and keeps a supported effort", () => {
  const page = mount(pageSheet);
  const ri = page.roleIndex("feature");
  page.choose(`p-${ri}-0`, "codex");
  expect(page.role("feature")).toBe("feature: codex:gpt-6.1-sol @high");
  expect(page.efforts(ri, 0)).toEqual(["low", "high", "ultra"]);
  page.tick(`e-${ri}-0-ultra`);
  expect(page.role("feature")).toBe("feature: codex:gpt-6.1-sol @ultra");
  page.choose(`p-${ri}-0`, "claude");
  expect(page.role("feature")).toBe("feature: opus");
  expect(page.message()).toContain("feature: opus @high -> opus");
});

test("a valid effort survives a provider change", () => {
  const page = mount(pageSheet);
  const ri = page.roleIndex("arena runners");
  page.choose(`p-${ri}-0`, "codex");
  page.choose(`p-${ri}-1`, "claude");
  expect(page.role("arena runners")).toBe("arena runners: codex:gpt-6.1-sol, opus @xhigh");
});

test("each model offers only its own effort levels", () => {
  const page = mount(pageSheet);
  const ri = page.roleIndex("arena runners");
  expect(page.efforts(ri, 0)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  page.choose(`m-${ri}-1`, "gpt-6-astra");
  expect(page.efforts(ri, 1)).toEqual(["low", "medium"]);
  expect(page.role("arena runners")).toBe("arena runners: opus @xhigh, codex:gpt-6-astra");
});

test("aliases have no provider select and stay bare, and an unlisted model is preserved", () => {
  const page = mount(pageSheet);
  expect(page.has(`p-${page.roleIndex("swarm workers")}-0`)).toBe(false);
  expect(page.role("swarm workers")).toBe("swarm workers: inherit-parent");
  expect(page.role("reflect tooling")).toBe("reflect tooling: ollama:qwen3:8b @high");
  const ri = page.roleIndex("why synthesizer");
  expect(page.role("why synthesizer")).toBe("why synthesizer: claude:opus @medium");
  page.tick(`e-${ri}-0-medium`);
  expect(page.role("why synthesizer")).toBe("why synthesizer: claude:opus");
});

test("repeat and remove edit a panel's slots and reset restores the sheet", () => {
  const page = mount(pageSheet);
  const ri = page.roleIndex("arena runners");
  page.press("Repeat", 0);
  expect(page.role("arena runners")).toBe("arena runners: opus @xhigh, opus @xhigh, codex:gpt-6.1-sol @xhigh");
  page.press("Remove", 1);
  page.choose(`m-${ri}-0`, "sonnet");
  expect(page.role("arena runners")).toBe("arena runners: sonnet @xhigh, codex:gpt-6.1-sol @xhigh");
  page.click("reset");
  expect(page.next()).toBe(pageSheet);
});

test("refuses a sheet whose roles differ from the file's", () => {
  expect(() => planApply(sheet, sheet.replace("feature:", "extra:"), sheet)).toThrow("refused");
  expect(() => planApply(sheet, sheet.replace("swarm workers: inherit-parent\n", ""), sheet)).toThrow("refused");
});

test("refuses an entry a dispatch would reject", () => {
  expect(() => planApply(sheet, sheet.replace("opus @high", "opus @turbo"), sheet)).toThrow("Unsupported claude effort for feature: turbo");
  expect(() => planApply(sheet, sheet.replace("feature: opus @high", "feature: claude-opus-5-5 @high"), sheet)).toThrow("write the family name, such as opus");
  expect(() => planApply(`${sheet}bug-fix: opus@high\n`, `${sheet}bug-fix: opus@high\n`, `${sheet}bug-fix: opus@high\n`)).toThrow("`opus @high`");
});

test("lists only the roles whose entries changed", () => {
  const next = sheet.replace("feature: opus @high", "feature: codex:gpt-6.1-sol @xhigh");
  expect(planApply(sheet, next, sheet).changes).toEqual([
    { role: "feature", from: "opus @high", to: "codex:gpt-6.1-sol @xhigh" },
  ]);
  expect(planApply(sheet, sheet, sheet).changes).toEqual([]);
});

function message(root, sheetPath, next, base = readFileSync(sheetPath, "utf8")) {
  const file = join(root, "message.txt");
  writeFileSync(file, [
    "/pstack-effort apply", `sheet: ${sheetPath}`, "scope: user", "",
    "```pstack-base", base.replace(/\n$/, ""), "```", "```pstack-sheet", next.replace(/\n$/, ""), "```",
  ].join("\n"));
  return file;
}

const twoNative = "feature: opus @high\narena runners: opus @xhigh, codex:gpt-6.1-sol @xhigh\n";

test("apply backs up the sheet and writes the new one", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  writeFileSync(sheetPath, twoNative);
  const next = twoNative.replace("opus @high", "opus @max");
  const logs = [];
  const result = apply({ message: message(root, sheetPath, next), env: { TUIOS_ENV: "1" }, log: (line) => logs.push(line) });
  expect(readFileSync(sheetPath, "utf8")).toBe(next);
  expect(readFileSync(`${sheetPath}.bak`, "utf8")).toBe(twoNative);
  expect(result.backup).toBe(`${sheetPath}.bak`);
  expect(existsSync(join(root, ".claude"))).toBe(false);
  expect(logs.join("\n")).toContain("feature: opus @high -> opus @max");
  expect(logs.join("\n")).not.toContain("none of them");
});

test("dry run writes nothing", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  writeFileSync(sheetPath, twoNative);
  apply({ message: message(root, sheetPath, twoNative.replace("@high", "@low")), dryRun: true, log: () => {} });
  expect(readFileSync(sheetPath, "utf8")).toBe(twoNative);
  expect(existsSync(`${sheetPath}.bak`)).toBe(false);
});

test("warns when the sheet routes to another harness and the shell has no multiplexer", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  writeFileSync(sheetPath, twoNative);
  const logs = [];
  apply({ message: message(root, sheetPath, twoNative.replace("@high", "@low")), env: {}, log: (line) => logs.push(line) });
  expect(logs.join("\n")).toContain("run as T3 Code subagents");
  expect(logs.join("\n")).toContain("need herdr, tuios, or tmux, and this shell runs in none of them");
});

test("the registry and the provider catalog agree, so the page only offers what a launch accepts", () => {
  for (const [id, spec] of Object.entries(harnesses)) {
    expect(spec.kind, id).toBeTruthy();
    expect(spec.command, id).toBeTruthy();
    expect(spec.access?.read?.length, id).toBeGreaterThan(0);
    expect(spec.access?.write?.length, id).toBeGreaterThan(0);
    expect(spec.t3?.driver, id).toBeTruthy();
  }
  for (const provider of providersJson.providers) {
    expect(Object.keys(harnesses), provider.id).toContain(provider.harness);
    for (const model of provider.models) {
      for (const effort of provider.efforts) {
        expect(() => foreignTarget(provider.id, { harness: provider.harness, model: model.slug, effort }), `${provider.id} ${model.slug}@${effort}`).not.toThrow();
      }
      expect(() => foreignTarget(provider.id, { harness: provider.harness, model: model.slug, effort: null })).not.toThrow();
    }
  }
});

test("a slot on Antigravity offers no effort levels and writes an entry the resolver and routing accept", () => {
  const page = mount(sheet);
  const ri = page.roleIndex("feature");
  page.choose(`p-${ri}-0`, "agy");
  expect(page.role("feature")).toBe("feature: agy:gemini-3.8-flash-high");
  expect(page.efforts(ri, 0)).toEqual([]);
  expect(page.options(`m-${ri}-0`)).toEqual(["Gemini 3.8 Flash (High)", "Gemini 3.8 Flash (Medium)", "Gemini 3.8 Flash (Low)", "inherit-parent (parent session's model)", "auto (parent session's model)"]);
  expect(page.rolesText()).toContain("this harness takes no effort setting; the effort is part of the model");
  page.choose(`m-${ri}-0`, "gemini-3.8-flash-low");
  expect(page.role("feature")).toBe("feature: agy:gemini-3.8-flash-low");
  const pasted = parseMessage(page.message());
  expect(resolveRole(pasted.next, "feature")).toEqual([{ harness: "agy", model: "gemini-3.8-flash-low", effort: null }]);
  expect(planApply(sheet, pasted.next, pasted.base).changes.map((c) => c.role)).toEqual(["feature"]);
});

test("apply writes an Antigravity slot that replaced an effort-bearing one", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  writeFileSync(sheetPath, twoNative);
  const next = twoNative.replace("codex:gpt-6.1-sol @xhigh", "agy:gemini-3.8-flash-high");
  apply({ message: message(root, sheetPath, next), env: { TUIOS_ENV: "1" }, log: () => {} });
  expect(resolveRole(readFileSync(sheetPath, "utf8"), "arena runners")).toEqual([
    { model: "opus", effort: "xhigh" },
    { harness: "agy", model: "gemini-3.8-flash-high", effort: null },
  ]);
  const stuck = twoNative.replace("codex:gpt-6.1-sol @xhigh", "agy:gemini-3.8-flash-high @xhigh");
  expect(() => apply({ message: message(root, sheetPath, stuck, next), env: {}, log: () => {} }))
    .toThrow("name the effort in the model id (agy:gemini-3.8-flash-high-xhigh)");
  expect(readFileSync(sheetPath, "utf8")).toBe(next);
});

test("rejects a message with no sheet block", () => {
  expect(() => parseMessage("/pstack-effort apply\nsheet: /x\n")).toThrow("pstack-base");
});

test("a cleared box inherits the sheet's default effort, and the page says which effort applies", () => {
  const page = mount(pageSheet);
  const ri = page.roleIndex("feature");
  page.tick(`e-${ri}-0-high`);
  expect(page.role("feature")).toBe("feature: opus");
  expect(resolveRole(page.next(), "feature")).toEqual([{ model: "opus", effort: "max" }]);
  expect(page.rolesText()).toContain("the sheet's default effort line sets max");
  const bare = mount(pageSheet.replace("default effort: max\n", ""));
  bare.tick(`e-${ri}-0-high`);
  expect(bare.role("feature")).toBe("feature: opus");
  expect(bare.rolesText()).toContain("runs at the session's effort");
});

test("an effort the model does not list is kept and called out", () => {
  const page = mount(pageSheet);
  expect(page.role("arena runners")).toContain("codex:gpt-6.1-sol @xhigh");
  expect(page.rolesText()).toContain("keeps effort xhigh, which this model does not list");
});

test("lines of roles the user did not touch stay exactly as written", () => {
  const spaced = pageSheet.replace("feature: opus @high", "feature:    opus @high");
  const page = mount(spaced);
  page.tick(`e-${page.roleIndex("swarm workers") + 1}-0-medium`);
  expect(page.next()).toContain("feature:    opus @high\n");
});

test("a saved draft is offered again only for the same sheet text, never against a sheet that gained lines", () => {
  const store = new Map();
  const dir = scratch();
  const first = mount(pageSheet, store, dir);
  first.tick(`e-${first.roleIndex("feature")}-0-high`);
  const revised = `# a note added above the roles\n${pageSheet}`;
  const other = mount(revised, store, dir);
  expect(other.next()).toBe(revised);
  expect(other.message()).toContain("changes: 0");
  const same = mount(pageSheet, store, dir);
  expect(same.role("feature")).toBe("feature: opus");
});

test("the message fence is longer than any backtick run inside the sheet", () => {
  const fenced = `${sheet}\nExample:\n\`\`\`\ncode\n\`\`\`\n`;
  const page = mount(fenced);
  page.tick(`e-${page.roleIndex("feature")}-0-high`);
  expect(page.message()).toContain("````pstack-sheet\n");
  expect(page.next()).toContain("Example:\n```\ncode\n```\n");
});

test("apply changes only the role lines of the file on disk, so lines added after the page was rendered survive", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  const rendered = "feature: opus @high\nbug-fix: opus @medium\n";
  const onDisk = `${rendered}\n# added after the page was rendered\ndefault effort: max\nsession hook: off\n`;
  writeFileSync(sheetPath, onDisk);
  apply({ message: message(root, sheetPath, rendered.replace("@high", "@low"), rendered), log: () => {} });
  expect(readFileSync(sheetPath, "utf8")).toBe(onDisk.replace("feature: opus @high", "feature: opus @low"));
});

test("apply leaves a role edited on disk after the page was rendered when the page did not touch it", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  const rendered = "feature: opus @high\nbug-fix: opus @medium\n";
  const onDisk = "feature: opus @max\nbug-fix: opus @medium\n";
  writeFileSync(sheetPath, onDisk);
  const result = apply({ message: message(root, sheetPath, rendered.replace("bug-fix: opus @medium", "bug-fix: opus @low"), rendered), log: () => {} });
  expect(readFileSync(sheetPath, "utf8")).toBe("feature: opus @max\nbug-fix: opus @low\n");
  expect(result.changes.map((c) => c.role)).toEqual(["bug-fix"]);
});

test("apply refuses a role the page changed when the file's line moved on, and writes nothing", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  const rendered = "feature: opus @high\nbug-fix: opus @medium\n";
  const onDisk = "feature: opus @max\nbug-fix: opus @medium\n";
  writeFileSync(sheetPath, onDisk);
  const file = message(root, sheetPath, rendered.replace("feature: opus @high", "feature: opus @low"), rendered);
  expect(() => apply({ message: file, log: () => {} })).toThrow(/refused: feature changed in the file after the page was rendered/);
  expect(readFileSync(sheetPath, "utf8")).toBe(onDisk);
  expect(existsSync(`${sheetPath}.bak`)).toBe(false);
});

test("the page's message carries the role lines as it read them, so apply can tell a stale page from an edit", () => {
  const page = mount(pageSheet);
  page.tick(`e-${page.roleIndex("feature")}-0-high`);
  const { base } = parseMessage(page.message());
  expect(base).toContain("feature: opus @high\n");
  expect(parseSheet(base).roles.map((r) => r.role)).toEqual(parseSheet(pageSheet).roles.map((r) => r.role));
});

test("apply keeps a sheet's code fence and CRLF endings intact", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  const onDisk = "feature: opus @high\r\n```\r\nnot a role: x\r\n```\r\nbug-fix: opus @medium\r\n";
  writeFileSync(sheetPath, onDisk);
  const next = "feature: opus @low\n```\nnot a role: x\n```\nbug-fix: opus @medium\n";
  const file = join(root, "message.txt");
  const base = onDisk.replace(/\r\n/g, "\n").replace(/\n$/, "");
  writeFileSync(file, `/pstack-effort apply\nsheet: ${sheetPath}\nscope: user\n\n\`\`\`\`pstack-base\n${base}\n\`\`\`\`\n\`\`\`\`pstack-sheet\n${next.replace(/\n$/, "")}\n\`\`\`\`\n`);
  apply({ message: file, log: () => {} });
  expect(readFileSync(sheetPath, "utf8")).toBe(onDisk.replace("@high", "@low"));
});

const userPreset = `# pstack model configuration

feature: opus
arena runners: codex:gpt-6-astra, sonnet
swarm workers: sonnet @low
bug-fix: opus @low
default effort: medium
`;

function presetTree(root = scratch()) {
  const user = join(root, "home", ".agents", "pstack", "presets");
  const project = join(root, "project", ".pstack", "presets");
  mkdirSync(user, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(user, "mid.md"), userPreset);
  writeFileSync(join(user, "empty.md"), "# nothing here\n");
  writeFileSync(join(project, "solo.md"), "feature: codex:gpt-6.1-sol @ultra\n");
  return root;
}

test("reads user and project presets with their roles and effort lines", () => {
  const root = presetTree();
  const presets = readPresets(join(root, "project"), join(root, "home"));
  expect(presets.map((p) => `${p.scope}/${p.name}`)).toEqual(["user/mid", "project/solo"]);
  expect(presets[0].defaultEffort).toBe("medium");
  expect(presets[0].roles[1]).toEqual({ role: "arena runners", slots: [
    { harness: "codex", model: "gpt-6-astra", effort: "" }, { harness: "", model: "sonnet", effort: "" },
  ] });
});

test("the preset select lists both scopes, and a page with none disables it", () => {
  expect(mount(pageSheet, new Map(), presetTree()).options("preset")).toEqual(["Choose a preset", "user/mid", "project/solo"]);
  const bare = mount(pageSheet);
  expect(bare.options("preset")).toEqual(["No presets saved"]);
  expect(bare.at("preset").attrs.disabled).toBe("");
});

test("loading a preset fills the roles it names and keeps the rest", () => {
  const page = mount(sheet, new Map(), presetTree());
  page.choose("preset", "0");
  expect(page.role("feature")).toBe("feature: opus @medium");
  expect(page.role("arena runners")).toBe("arena runners: codex:gpt-6-astra @medium, sonnet @medium");
  expect(page.role("swarm workers")).toBe("swarm workers: sonnet @low");
  expect(page.role("why synthesizer")).toBe("why synthesizer: claude:opus @medium");
  expect(page.message()).toContain("changes: 3");
  expect(page.at("preset-note").textContent).toBe(
    "Loaded user/mid. Not in the preset, kept as is: why synthesizer. Not on this sheet, skipped: bug-fix.");
  const pasted = parseMessage(page.message());
  expect(planApply(sheet, pasted.next, pasted.base).changes.map((c) => c.role)).toEqual(["feature", "arena runners", "swarm workers"]);
  page.choose("preset", "1");
  expect(page.role("feature")).toBe("feature: codex:gpt-6.1-sol @ultra");
  page.click("reset");
  expect(page.next()).toBe(sheet);
  expect(page.at("preset-note").textContent).toBe("");
});
