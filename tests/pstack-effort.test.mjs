import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { resolveRole } from "../plugins/pstack/skills/poteto-mode/scripts/resolve-models.mjs";
import { apply, parseMessage, planApply } from "../plugins/pstack/skills/pstack-effort/scripts/apply.mjs";
import { buildProviders, codexModels } from "../plugins/pstack/skills/pstack-effort/scripts/render.mjs";
import { parseSheet, slotText } from "../plugins/pstack/skills/pstack-effort/scripts/sheet.mjs";

const render = fileURLToPath(new URL("../plugins/pstack/skills/pstack-effort/scripts/render.mjs", import.meta.url));
const providersJson = JSON.parse(readFileSync(new URL("../plugins/pstack/skills/pstack-effort/providers.json", import.meta.url), "utf8"));

const sheet = `# pstack model configuration
Roles below are edited by the page.

feature: claude-opus-5-5@high
arena runners: claude-opus-5-5@xhigh, codex:gpt-6.1-sol@xhigh
swarm workers: inherit-parent
why synthesizer: claude:claude-opus-5-5@medium
effort: claude-opus-5-5 = max
session hook: off
`;

const pageSheet = sheet.replace("effort:", "reflect tooling: ollama:qwen3:8b@high\neffort:");

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
    role: "arena runners", line: lines.indexOf("arena runners: claude-opus-5-5@xhigh, codex:gpt-6.1-sol@xhigh"),
    slots: [{ harness: "", model: "claude-opus-5-5", effort: "xhigh" }, { harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" }],
  });
  expect(roles[3].slots[0].harness).toBe("claude");
  expect(roles[4].slots[0]).toEqual({ harness: "", model: "ollama:qwen3:8b", effort: "high" });
  expect(roles.flatMap((r) => r.slots.map(slotText))).toContain("codex:gpt-6.1-sol@xhigh");
});

test("skips a line with an entry it cannot parse", () => {
  expect(parseSheet("feature: codex:auto\nbug-fix: claude-opus-5-5\n").roles.map((r) => r.role)).toEqual(["bug-fix"]);
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
  const available = [{ slug: "claude-opus-5-5", label: "dup" }, { slug: "claude-extra", label: "Extra" }];
  const [anthropic, openai] = buildProviders({ providers: providersJson.providers, available, codex: null });
  expect(anthropic.models.map((m) => m.slug)).toContain("claude-extra");
  expect(anthropic.models.filter((m) => m.slug === "claude-opus-5-5")).toHaveLength(1);
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

function renderPage(text) {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  const out = join(root, "page.html");
  writeFileSync(sheetPath, text);
  const run = spawnSync(process.execPath, [render, "--sheet", sheetPath, "--out", out, "--scope", "user", "--config-dir", join(root, ".claude")], {
    encoding: "utf8", env: { ...process.env, CODEX_HOME: cacheHome() },
  });
  expect(run.status).toBe(0);
  return { html: readFileSync(out, "utf8"), sheetPath, root };
}

test("renders the sheet into the page with escaped data and no placeholder left", () => {
  const { html } = renderPage(`${sheet}note: </script><b>\n`);
  expect(html).not.toContain("/*__PSTACK_DATA__*/");
  expect(html).not.toContain("__SCRIPT__");
  expect(html).not.toContain("</script><b>");
  expect(html).toContain("codex:gpt-6.1-sol@xhigh");
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

function mount(text) {
  const { html } = renderPage(text);
  const script = /<script>\n([\s\S]*)\n<\/script>/.exec(html)[1];
  const root = new Node("root");
  for (const id of ["meta", "legend", "roles", "changes", "out", "reset", "copy", "status"]) { const n = new Node("div"); n.setAttribute("id", id); root.append(n); }
  const store = new Map();
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
  return { choose, tick, message, role, roleIndex, efforts, press, rolesText, has: (id) => Boolean(root.find(id)), click: (id) => at(id).fire("click"), next: () => parseMessage(message()).next };
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
  expect(page.role("feature")).toBe("feature: codex:gpt-6.1-sol@high");
  expect(page.efforts(ri, 0)).toEqual(["low", "high", "ultra"]);
  page.tick(`e-${ri}-0-ultra`);
  expect(page.role("feature")).toBe("feature: codex:gpt-6.1-sol@ultra");
  page.choose(`p-${ri}-0`, "claude");
  expect(page.role("feature")).toBe("feature: claude-opus-5-5@default");
  expect(page.message()).toContain("feature: claude-opus-5-5@high -> claude-opus-5-5@default");
});

test("a valid effort survives a provider change", () => {
  const page = mount(pageSheet);
  const ri = page.roleIndex("arena runners");
  page.choose(`p-${ri}-0`, "codex");
  page.choose(`p-${ri}-1`, "claude");
  expect(page.role("arena runners")).toBe("arena runners: codex:gpt-6.1-sol, claude-opus-5-5@xhigh");
});

test("each model offers only its own effort levels", () => {
  const page = mount(pageSheet);
  const ri = page.roleIndex("arena runners");
  expect(page.efforts(ri, 0)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  page.choose(`m-${ri}-1`, "gpt-6-astra");
  expect(page.efforts(ri, 1)).toEqual(["low", "medium"]);
  expect(page.role("arena runners")).toBe("arena runners: claude-opus-5-5@xhigh, codex:gpt-6-astra");
});

test("aliases have no provider select and stay bare, and an unlisted model is preserved", () => {
  const page = mount(pageSheet);
  expect(page.has(`p-${page.roleIndex("swarm workers")}-0`)).toBe(false);
  expect(page.role("swarm workers")).toBe("swarm workers: inherit-parent");
  expect(page.role("reflect tooling")).toBe("reflect tooling: ollama:qwen3:8b@high");
  const ri = page.roleIndex("why synthesizer");
  expect(page.role("why synthesizer")).toBe("why synthesizer: claude:claude-opus-5-5@medium");
  page.tick(`e-${ri}-0-medium`);
  expect(page.role("why synthesizer")).toBe("why synthesizer: claude:claude-opus-5-5@default");
});

test("repeat and remove edit a panel's slots and reset restores the sheet", () => {
  const page = mount(pageSheet);
  const ri = page.roleIndex("arena runners");
  page.press("Repeat", 0);
  expect(page.role("arena runners")).toBe("arena runners: claude-opus-5-5@xhigh, claude-opus-5-5@xhigh, codex:gpt-6.1-sol@xhigh");
  page.press("Remove", 1);
  page.choose(`m-${ri}-0`, "claude-sonnet-5-5");
  expect(page.role("arena runners")).toBe("arena runners: claude-sonnet-5-5@xhigh, codex:gpt-6.1-sol@xhigh");
  page.click("reset");
  expect(page.next()).toBe(pageSheet);
});

test("refuses a sheet whose roles differ from the file's", () => {
  expect(() => planApply(sheet, sheet.replace("feature:", "extra:"))).toThrow("refused");
  expect(() => planApply(sheet, sheet.replace("swarm workers: inherit-parent\n", ""))).toThrow("refused");
});

test("refuses an entry the routing helper rejects", () => {
  expect(() => planApply(sheet, sheet.replace("claude-opus-5-5@high", "claude-opus-5-5@turbo"))).toThrow("Unsupported Claude Code effort");
  expect(() => planApply(sheet, sheet.replace("feature: claude-opus-5-5@high", "feature: openai/gpt-6@high"))).toThrow("Invalid model assignment for feature");
});

test("lists only the roles whose entries changed", () => {
  const next = sheet.replace("feature: claude-opus-5-5@high", "feature: codex:gpt-6.1-sol@xhigh");
  expect(planApply(sheet, next).changes).toEqual([
    { role: "feature", from: "claude-opus-5-5@high", to: "codex:gpt-6.1-sol@xhigh", foreign: [{ harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" }] },
  ]);
  expect(planApply(sheet, sheet).changes).toEqual([]);
});

function message(root, sheetPath, next) {
  const file = join(root, "message.txt");
  writeFileSync(file, ["/pstack-effort apply", `sheet: ${sheetPath}`, "scope: user", `config-dir: ${join(root, ".claude")}`, "", "```pstack-sheet", next.replace(/\n$/, ""), "```"].join("\n"));
  return file;
}

const twoNative = "feature: claude-opus-5-5@high\narena runners: claude-opus-5-5@xhigh, codex:gpt-6.1-sol@xhigh\n";

test("apply backs up the sheet, writes the new one and installs agents for native entries only", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  writeFileSync(sheetPath, twoNative);
  const next = twoNative.replace("claude-opus-5-5@high", "claude-opus-5-5@max");
  const logs = [];
  const result = apply({ message: message(root, sheetPath, next), env: { TUIOS_ENV: "1" }, log: (line) => logs.push(line) });
  expect(readFileSync(sheetPath, "utf8")).toBe(next);
  expect(readFileSync(`${sheetPath}.bak`, "utf8")).toBe(twoNative);
  expect(result.agents.sort()).toEqual(["pstack-claude-opus-5-5-max", "pstack-claude-opus-5-5-xhigh"]);
  expect(existsSync(join(root, ".claude", "agents", "pstack-claude-opus-5-5-max.md"))).toBe(true);
  expect(existsSync(join(root, ".claude", "agents", "pstack-codex-gpt-6.1-sol-xhigh.md"))).toBe(false);
  expect(logs.join("\n")).toContain("feature: claude-opus-5-5@high -> claude-opus-5-5@max");
  expect(logs.join("\n")).not.toContain("neither");
});

test("dry run writes nothing", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  writeFileSync(sheetPath, twoNative);
  apply({ message: message(root, sheetPath, twoNative.replace("@high", "@low")), dryRun: true, log: () => {} });
  expect(readFileSync(sheetPath, "utf8")).toBe(twoNative);
  expect(existsSync(`${sheetPath}.bak`)).toBe(false);
});

test("warns when the sheet routes to another harness and the session has no multiplexer", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  writeFileSync(sheetPath, twoNative);
  const logs = [];
  apply({ message: message(root, sheetPath, twoNative.replace("@high", "@low")), env: {}, log: (line) => logs.push(line) });
  expect(logs.join("\n")).toContain("needs herdr or tuios");
});

test("restores the sheet when the agent install fails", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  writeFileSync(sheetPath, twoNative);
  writeFileSync(join(root, ".claude"), "not a directory");
  const next = twoNative.replace("@high", "@low");
  expect(() => apply({ message: message(root, sheetPath, next), log: () => {} })).toThrow("restored");
  expect(readFileSync(sheetPath, "utf8")).toBe(twoNative);
});

test("rejects a message with no sheet block", () => {
  expect(() => parseMessage("/pstack-effort apply\nsheet: /x\n")).toThrow("fenced block");
});

test("a cleared box writes @default when the sheet has a model-wide effort line, so the resolver agrees with the page", () => {
  const page = mount(pageSheet);
  const ri = page.roleIndex("feature");
  page.tick(`e-${ri}-0-high`);
  expect(page.role("feature")).toBe("feature: claude-opus-5-5@default");
  expect(resolveRole(page.next(), "feature")).toEqual([{ model: "claude-opus-5-5", effort: null }]);
  const bare = mount(pageSheet.replace("effort: claude-opus-5-5 = max\n", ""));
  bare.tick(`e-${ri}-0-high`);
  expect(bare.role("feature")).toBe("feature: claude-opus-5-5");
});

test("a slot with no box ticked says which effort applies", () => {
  const page = mount(pageSheet.replace("feature: claude-opus-5-5@high", "feature: claude-opus-5-5"));
  expect(page.rolesText()).toContain("the sheet's effort line sets max for this model");
});

test("an effort the model does not list is kept and called out", () => {
  const page = mount(pageSheet);
  expect(page.role("arena runners")).toContain("codex:gpt-6.1-sol@xhigh");
  expect(page.rolesText()).toContain("keeps effort xhigh, which this model does not list");
});

test("lines of roles the user did not touch stay exactly as written", () => {
  const spaced = pageSheet.replace("feature: claude-opus-5-5@high", "feature:    claude-opus-5-5@high");
  const page = mount(spaced);
  page.tick(`e-${page.roleIndex("swarm workers") + 1}-0-medium`);
  expect(page.next()).toContain("feature:    claude-opus-5-5@high\n");
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
  const rendered = "feature: claude-opus-5-5@high\nbug-fix: claude-opus-5-5@medium\n";
  const onDisk = `${rendered}\n# added after the page was rendered\neffort: claude-opus-5-5 = max\nsession hook: off\n`;
  writeFileSync(sheetPath, onDisk);
  apply({ message: message(root, sheetPath, rendered.replace("@high", "@low")), log: () => {} });
  expect(readFileSync(sheetPath, "utf8")).toBe(onDisk.replace("feature: claude-opus-5-5@high", "feature: claude-opus-5-5@low"));
});

test("apply keeps a sheet's code fence and CRLF endings intact", () => {
  const root = scratch();
  const sheetPath = join(root, "pstack-models.md");
  const onDisk = "feature: claude-opus-5-5@high\r\n```\r\nnot a role: x\r\n```\r\nbug-fix: claude-opus-5-5@medium\r\n";
  writeFileSync(sheetPath, onDisk);
  const next = "feature: claude-opus-5-5@low\n```\nnot a role: x\n```\nbug-fix: claude-opus-5-5@medium\n";
  const file = join(root, "message.txt");
  writeFileSync(file, `/pstack-effort apply\nsheet: ${sheetPath}\nscope: user\nconfig-dir: ${join(root, ".claude")}\n\n\`\`\`\`pstack-sheet\n${next.replace(/\n$/, "")}\n\`\`\`\`\n`);
  apply({ message: file, log: () => {} });
  expect(readFileSync(sheetPath, "utf8")).toBe(onDisk.replace("@high", "@low"));
});
