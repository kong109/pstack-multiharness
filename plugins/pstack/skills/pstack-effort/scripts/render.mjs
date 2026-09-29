#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseSheet } from "./sheet.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, "..");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export function codexModels(home = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  const path = join(home, "models_cache.json");
  if (!existsSync(path)) return null;
  const listed = readJson(path).models?.filter((m) => m.visibility === "list") ?? [];
  if (!listed.length) return null;
  return listed.map((m) => ({
    slug: m.slug,
    label: m.display_name ?? m.slug,
    efforts: (m.supported_reasoning_levels ?? []).map((level) => level.effort ?? level).filter(Boolean),
  }));
}

export function buildProviders({ providers, available, codex }) {
  return providers.map((provider) => {
    let models = provider.models;
    if (provider.harness === "claude") {
      const known = new Set(models.map((m) => m.slug));
      models = [...models, ...available.filter((m) => !known.has(m.slug))];
    }
    if (provider.harness === "codex" && codex) models = codex;
    return {
      ...provider,
      models: models.map((m) => ({ slug: m.slug, label: m.label, efforts: m.efforts?.length ? m.efforts : provider.efforts })),
    };
  });
}

export function pageData({ sheetPath, scope, configDir, native, generated, text, catalog }) {
  const { lines, roles } = parseSheet(text);
  if (!roles.length) throw new Error(`no role lines found in ${sheetPath}`);
  return {
    sheetPath, scope, configDir, native, generated, lines, roles,
    providers: buildProviders(catalog),
  };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    sheet: { type: "string" }, out: { type: "string" }, scope: { type: "string" },
    "config-dir": { type: "string" }, native: { type: "string" },
  } });
  if (!values.sheet || !values.out) {
    throw new Error("usage: render.mjs --sheet <models.md> --out <page.html> [--scope project|user] [--config-dir <dir>] [--native claude|codex]");
  }
  const defaults = readJson(join(skillDir, "providers.json"));
  const modelsPath = join(skillDir, "..", "..", "models.json");
  const available = existsSync(modelsPath) ? readJson(modelsPath).available ?? [] : [];
  const sheetPath = resolve(values.sheet);
  const data = pageData({
    sheetPath,
    scope: values.scope ?? "project",
    configDir: values["config-dir"] ? resolve(values["config-dir"]) : "",
    native: values.native ?? defaults.native,
    generated: new Date().toISOString().slice(0, 16).replace("T", " "),
    text: readFileSync(sheetPath, "utf8"),
    catalog: { providers: defaults.providers, available, codex: codexModels() },
  });
  const template = readFileSync(join(skillDir, "template.html"), "utf8");
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  writeFileSync(values.out, template.replace("/*__PSTACK_DATA__*/null", () => json));
  console.log(`rendered ${data.roles.length} roles from ${sheetPath} -> ${resolve(values.out)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
