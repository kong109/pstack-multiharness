import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { harnesses, resolveRole } from "./resolve-models.mjs";

export const skill = fileURLToPath(new URL("../SKILL.md", import.meta.url));

export function workerBrief(marker) {
  return `${marker}

Follow the parent's assigned task and scope. Read the poteto-mode instructions at ${skill} before working. If the task supplies a specialist prompt or reference, read it and preserve that specialty. Do not replace the assigned task with an unrelated workflow. Report evidence and limitations accurately.
`;
}

export function agentName(reference) {
  return `pstack-${reference.replace(/[^a-z0-9]+/g, "-")}`;
}

export function foreignTarget(label, { harness, model, effort }) {
  const { effort: flag, efforts } = harnesses[harness];
  if (effort !== null && !flag) throw new Error(`${harness} takes no effort setting (${label}: ${model}@${effort})`);
  if (effort !== null && efforts && !efforts.includes(effort)) {
    throw new Error(`Unsupported ${harness} effort for ${label}: ${effort} (use ${efforts.join(", ")})`);
  }
  return { agent: null, harness, model, effort, pane: true };
}

// An adapter maps one resolved {model, effort} pair to a route target and, when the runtime needs a
// generated agent to carry that pair, the profile to install: { target, profile?: { agent, key, text } }.
export function routesFromSheet(text, adapter) {
  const routes = {};
  const profiles = new Map();
  const texts = new Map();
  for (const line of text.split("\n")) {
    const row = line.trim().match(/^([a-z][a-z ,\/-]*):\s*(\S.*)$/);
    if (!row) continue;
    const [, label] = row;
    if (label === "effort" || label === "session hook") continue;
    const targets = resolveRole(text, label).map(({ harness, ...pair }) => {
      if (harness && harness !== adapter.harness) return foreignTarget(label, { harness, ...pair });
      const { target, profile } = adapter.route(label, pair);
      if (profile) {
        if (profiles.has(profile.agent) && profiles.get(profile.agent) !== profile.key) {
          throw new Error(`Agent name collision: ${profile.agent}`);
        }
        profiles.set(profile.agent, profile.key);
        texts.set(profile.agent, profile.text);
      }
      return target;
    });
    for (const role of [label, ...label.split(",").map((value) => value.trim())]) {
      if (routes[role] && JSON.stringify(routes[role]) !== JSON.stringify(targets)) {
        throw new Error(`Conflicting assignment for ${role}`);
      }
      routes[role] = targets;
    }
  }
  if (Object.keys(routes).length === 0) throw new Error("No role assignments found");
  return { routes, profiles, texts };
}

export function installProfiles(mapping, configDir, adapter, { check = false } = {}) {
  const { routes, profiles, texts } = routesFromSheet(readFileSync(mapping, "utf8"), adapter);
  const files = [...texts].map(([agent, text]) => [join(configDir, "agents", `${agent}.md`), text]);
  const manifest = join(configDir, "pstack-routing.json");
  const content = JSON.stringify({ generatedBy: adapter.id, mapping: resolve(mapping), routes }, null, 2) + "\n";
  for (const [path, expected] of files) {
    if (existsSync(path)) {
      const current = readFileSync(path, "utf8");
      if (current !== expected && !current.includes(adapter.marker)) throw new Error(`Refusing to overwrite unmanaged agent: ${path}`);
    }
  }
  if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).generatedBy !== adapter.id) {
    throw new Error(`Refusing to overwrite unmanaged routing file: ${manifest}`);
  }
  const outputs = [...files, [manifest, content]];
  const stale = outputs.filter(([path, expected]) => !existsSync(path) || readFileSync(path, "utf8") !== expected);
  if (check && stale.length) throw new Error(`Pstack routing is stale in ${configDir}; rerun with --install`);
  if (!check) {
    for (const [path, expected] of stale) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, expected);
    }
  }
  return { routes, agents: [...profiles.keys()] };
}

export function main(args, adapter) {
  const { values } = parseArgs({ args, options: {
    mapping: { type: "string" }, "config-dir": { type: "string" },
    install: { type: "boolean" }, check: { type: "boolean" }, role: { type: "string" },
  } });
  if (!values.mapping || !values["config-dir"] || (values.install && values.check)) {
    throw new Error("Use --mapping FILE --config-dir DIR with --install, --check, or --role ROLE");
  }
  if (!values.install && !values.check && !values.role) throw new Error("Choose --install, --check, or --role ROLE");
  const result = installProfiles(resolve(values.mapping), resolve(values["config-dir"]), adapter, { check: !values.install });
  if (values.role) {
    const targets = result.routes[values.role];
    if (!targets) throw new Error(`No assignment for role: ${values.role}`);
    console.log(JSON.stringify(targets, null, 2));
  } else {
    console.log(JSON.stringify({ agents: result.agents, status: values.install ? "installed" : "current" }, null, 2));
  }
}

export function runIfMain(importMetaUrl, adapter) {
  if (!process.argv[1] || importMetaUrl !== pathToFileURL(realpathSync(resolve(process.argv[1]))).href) return;
  try { main(process.argv.slice(2), adapter); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
