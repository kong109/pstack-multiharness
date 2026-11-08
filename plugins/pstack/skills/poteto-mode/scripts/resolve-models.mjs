#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const token = /^[a-zA-Z0-9_./:#-]+$/;
const harnessName = /^[a-z][a-z0-9-]*$/;

const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));

export const harnesses = readJson("./harnesses.json");
export const { native, providers } = readJson("./providers.json");
const registry = { harnesses, providers, native };

export const takesEffort = (harness, list = harnesses) => list[harness].effort !== null;

const aliases = new Set(["auto", "inherit-parent"]);

export function parseEntry(entry, list = harnesses) {
  const text = entry.trim();
  const invalid = (why) => new Error(`Invalid model entry: ${text}${why ? ` (${why})` : ""}`);
  const [head, spaced, ...extra] = text.split(/\s+/);
  if (extra.length || (spaced !== undefined && !/^@[^@]+$/.test(spaced))) throw invalid();
  const arrow = head.indexOf("->");
  const model = arrow < 0 ? head : head.slice(0, arrow);
  // An unquoted `muse->pi` in a shell redirects to a file named pi and leaves `muse-`; no model id ends in `-`.
  if (arrow < 0 && model.endsWith("-")) {
    throw invalid(`the shell read \`->\` as a redirect, so quote the entry, as in '${model}>harness', and delete the file it created, named after the harness`);
  }
  let harness = null;
  let explicitEffort = spaced?.slice(1);
  if (arrow >= 0) {
    const [name, joined, ...more] = head.slice(arrow + 2).split("@");
    if (more.length || !harnessName.test(name) || (joined !== undefined && (!joined || explicitEffort !== undefined))) throw invalid();
    harness = name;
    explicitEffort ??= joined;
  } else if (model.includes("@")) {
    throw invalid(spaced ? "" : `write the effort after a space, as in \`${text.replace("@", " @")}\``);
  }
  const colon = model.indexOf(":");
  if (colon > 0 && Object.hasOwn(list, model.slice(0, colon))) {
    throw invalid(`name the harness after the model, as in \`${model.slice(colon + 1)}->${harness ?? model.slice(0, colon)}${spaced ? ` ${spaced}` : ""}\``);
  }
  if (!model || !token.test(model) || (explicitEffort !== undefined && !token.test(explicitEffort))) throw invalid();
  if (harness && aliases.has(model)) throw invalid(`a ->${harness} entry names a model or a provider`);
  return { model, harness, explicitEffort };
}

export const providerOf = (model, catalog = providers) =>
  catalog.find((p) => p.models.some((m) => m.slug === model) || (p.match && new RegExp(p.match).test(model)));

// A provider marked levelledIds also takes a model id ending in its effort level, the way `agy models` lists them.
export const levelledIds = (catalog = providers) =>
  new Map(catalog.filter((p) => p.levelledIds).flatMap((p) => p.models.flatMap((m) => p.efforts.map((e) => [`${m.slug}-${e}`, [m.slug, e]]))));

export const ownProvider = (model, catalog = providers) =>
  catalog.find((p) => p.harness === model) ?? (model.includes("/") || aliases.has(model) ? undefined : providerOf(model, catalog));

// A provider's harness name stands for its default model, and a model with a provider runs on that provider's harness unless the entry names one.
// The registry maps only what a subscription allows. A `provider/model` id runs on any harness unchecked, for an operator with an API key or an open-weight model.
// `harness` is left out when it is the session's own. A session outside the registry runs every entry without an arrow natively.
export function resolveEntry({ model: written, harness: chosen, explicitEffort }, { defaultEffort = "session", ...given } = {}) {
  const { harnesses: list, providers: catalog, native: home } = { ...registry, ...given };
  const session = given.session ?? home;
  const named = catalog.find((p) => p.harness === written);
  if (!chosen && !named && !Object.hasOwn(list, session)) {
    const effort = explicitEffort ?? defaultEffort;
    return { model: aliases.has(written) ? null : written, effort: effort === "session" ? null : effort };
  }
  const model = named ? named.default : written;
  const provider = ownProvider(written, catalog);
  const harness = chosen ?? provider?.harness ?? session;
  if (!Object.hasOwn(list, harness)) {
    throw new Error(`Unknown harness: ${harness} in ${written}->${harness} (registered: ${Object.keys(list).join(", ")})`);
  }
  let id = model;
  if (provider) {
    const template = list[harness].providers?.[provider.id];
    if (!template) {
      const serving = Object.keys(list).filter((h) => list[h].providers?.[provider.id]);
      const keyed = catalog.some((p) => p.harness === harness) ? "" : `; with an API key, write the id ${harness} takes, as in \`provider/${model}->${harness}\``;
      throw new Error(`${harness} runs no ${provider.label} models, so it cannot run ${model}${serving.length ? ` (use ${serving.map((h) => `${written}->${h}`).join(" or ")})` : ""}${keyed}`);
    }
    id = template.replaceAll("{model}", model);
  }
  // A levelled id keeps its level, since agy refuses a second effort on top. A default the harness does not list is left off.
  const levelled = levelledIds(catalog).get(model);
  if (levelled && explicitEffort !== undefined && explicitEffort !== "session") {
    throw new Error(`${model} already names its effort, so write \`${levelled[0]} @${explicitEffort}\` instead of \`${model} @${explicitEffort}\``);
  }
  const listed = list[harness].efforts;
  const fallback = takesEffort(harness, list) && !levelled && (!listed || defaultEffort === "session" || listed.includes(defaultEffort));
  const effort = explicitEffort ?? (fallback ? defaultEffort : undefined);
  return {
    ...(harness !== session && { harness }),
    model: aliases.has(id) ? null : id,
    effort: effort === undefined || effort === "session" ? null : effort,
  };
}

export function resolveRole(text, role, defaults, options = {}) {
  let value;
  let defaultEffort = "session";
  for (const source of text.split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith("#") || line.startsWith("```")) continue;
    if (/^effort:/.test(line)) {
      throw new Error(`Unsupported line: ${line} (put the effort on each entry, as in \`model @high\`, or use a \`default effort:\` line)`);
    }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1).trim();
    if (key === "default effort") {
      if (!token.test(rest)) throw new Error(`Invalid default effort: ${rest}`);
      defaultEffort = rest;
    } else if (key === role) {
      if (value !== undefined) throw new Error(`Duplicate role: ${key}`);
      value = rest;
    }
  }
  value ??= defaults;
  if (!value) throw new Error(`No mapping or defaults for role: ${role}`);
  return value.split(",").map((entry) => resolveEntry(parseEntry(entry, options.harnesses), { ...options, defaultEffort }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { session: { type: "string" } } });
    const [file, role, defaults, ...extra] = positionals;
    if (!file || !role || extra.length) {
      throw new Error('Usage: resolve-models.mjs [--session <harness>] <sheet|-> "role" ["default-models"]');
    }
    const text = file === "-" ? "" : readFileSync(file, "utf8");
    if (values.session && !Object.hasOwn(harnesses, values.session)) {
      console.error(`note: ${values.session} is not a registered harness (${Object.keys(harnesses).join(", ")}), so every entry without an arrow runs natively`);
    }
    console.log(JSON.stringify(resolveRole(text, role, defaults, { session: values.session }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
