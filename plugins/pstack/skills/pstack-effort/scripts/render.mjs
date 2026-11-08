#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { levelledIds, ownProvider, harnesses as registry } from "../../poteto-mode/scripts/resolve-models.mjs";
import { allRoleLabels, parseSheet } from "./sheet.mjs";
import { listPresets, presetDirectory } from "../../pstack-preset/scripts/presets.mjs";

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
      models = [...models, ...available.filter((slug) => !known.has(slug)).map((slug) => ({ slug, label: slug }))];
    }
    if (provider.harness === "codex" && codex) models = codex;
    return {
      ...provider,
      models: models.map((m) => ({ slug: m.slug, label: m.label, efforts: m.efforts?.length ? m.efforts : provider.efforts })),
    };
  });
}

export function readPresets(project = process.cwd(), home = homedir()) {
  return ["user", "project"].flatMap((scope) => {
    const directory = presetDirectory(scope, project, home);
    return listPresets(directory).flatMap((name) => {
      const { roles, defaultEffort } = parseSheet(readFileSync(join(directory, `${name}.md`), "utf8"));
      return roles.length ? [{ scope, name, roles: roles.map(({ role, slots }) => ({ role, slots })), defaultEffort }] : [];
    });
  });
}

export function providerFor(model, providers, native) {
  if (model === "auto" || model === "inherit-parent") return providers.find((p) => p.harness === native)?.id ?? "";
  return ownProvider(model, providers)?.id ?? "";
}

export const harnessChoices = (list) => Object.fromEntries(Object.entries(list).map(([name, spec]) => [name, {
  providers: Object.keys(spec.providers ?? {}), takesEffort: spec.effort !== null, efforts: spec.efforts ?? null,
}]));

export function pageData({ sheetPath, scope, native, generated, text, catalog, presets = [], harnesses = registry }) {
  const { lines, roles, defaultEffort } = parseSheet(text);
  if (!roles.length) throw new Error(`no role lines found in ${sheetPath}`);
  const withProvider = (list) => list.map((r) => ({ ...r, slots: r.slots.map((s) => ({ ...s, provider: providerFor(s.model, catalog.providers, native) })) }));
  return {
    sheetPath, scope, native, generated, lines, defaultEffort,
    roles: withProvider(roles),
    presets: presets.map((p) => ({ ...p, roles: withProvider(p.roles) })),
    providers: buildProviders(catalog),
    harnesses: harnessChoices(harnesses),
    levelled: [...levelledIds(catalog.providers).keys()],
  };
}

export function pageHtml(data) {
  const template = readFileSync(join(skillDir, "template.html"), "utf8");
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return template.replace("/*__PSTACK_DATA__*/null", () => json);
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    sheet: { type: "string" }, out: { type: "string" }, scope: { type: "string" },
    native: { type: "string" }, "project-root": { type: "string" },
  } });
  if (!values.sheet || !values.out) {
    throw new Error("usage: render.mjs --sheet <models.md> --out <page.html> [--scope project|user] [--native claude|codex] [--project-root <dir>]");
  }
  const defaults = readJson(join(skillDir, "..", "poteto-mode", "scripts", "providers.json"));
  const modelsPath = join(skillDir, "..", "..", "models.json");
  const available = existsSync(modelsPath) ? readJson(modelsPath).available ?? [] : [];
  const sheetPath = resolve(values.sheet);
  const text = readFileSync(sheetPath, "utf8");
  const data = pageData({
    sheetPath,
    scope: values.scope ?? "project",
    native: values.native ?? defaults.native,
    generated: new Date().toISOString().slice(0, 16).replace("T", " "),
    text,
    catalog: { providers: defaults.providers, available, codex: codexModels() },
    presets: readPresets(resolve(values["project-root"] ?? process.cwd())),
  });
  writeFileSync(values.out, pageHtml(data));
  console.log(`rendered ${data.roles.length} roles and ${data.presets.length} presets from ${sheetPath} -> ${resolve(values.out)}`);
  const shown = new Set(data.roles.map((r) => r.role));
  const skipped = allRoleLabels(text).filter((role) => !shown.has(role));
  if (skipped.length) {
    console.log(`left off the page, because an entry does not parse: ${skipped.join("; ")}. If they use the old harness:model form, run node ${join(skillDir, "..", "poteto-mode", "scripts", "migrate-sheet.mjs")} ${sheetPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
