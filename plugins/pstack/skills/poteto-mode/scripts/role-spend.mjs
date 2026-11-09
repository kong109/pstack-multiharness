#!/usr/bin/env node
// Token spend per pstack role from Claude Code session transcripts, with a check of each spawn's model against the sheet.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveRole } from "./resolve-models.mjs";

const models = JSON.parse(readFileSync(new URL("../../../models.json", import.meta.url), "utf8"));
const familyRe = new RegExp(`\\b(${models.available.join("|")})\\b`);
const legacyAgentRe = new RegExp(`^pstack-(.+)-(${models.efforts.join("|")})$`);
const tagRe = /^\[([^\]]+)\]\s*/;

export const familyOf = (model) => (model ? model.match(familyRe)?.[1] ?? model : null);

// A role key such as `feature, refactoring` answers to the whole key or to either name in it.
export const roleNames = new Map(
  models.roles.flatMap(({ role, models: tier }) => {
    const defaults = [models.tiers[tier]].flat().join(",");
    const entry = [role, defaults];
    return [[role, entry], ...role.split(",").map((part) => [part.trim(), entry])];
  }),
);

const emptyUsage = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

function readJsonl(path) {
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

// One API reply is written as several transcript lines that repeat its usage, so each message id counts once.
export function spend(entries) {
  const byMessage = new Map();
  for (const entry of entries) {
    const message = entry.type === "assistant" ? entry.message : null;
    if (message?.usage && message.model !== "<synthetic>") byMessage.set(message.id ?? byMessage.size, message);
  }
  const usage = emptyUsage();
  const ran = new Set();
  for (const { usage: u, model } of byMessage.values()) {
    usage.input += u.input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    ran.add(model);
  }
  return { usage, ran: [...ran] };
}

function agentCalls(entries) {
  const calls = new Map();
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    for (const block of entry.message?.content ?? []) {
      if (block?.type === "tool_use" && (block.name === "Agent" || block.name === "Task")) calls.set(block.id, block.input ?? {});
    }
  }
  return calls;
}

// Before 0.9.133 the routed agent's name carried its model and effort, as pstack-<model>-<effort>.
function requested(call, agentType) {
  if (call.model || call.effort) return { model: call.model ?? null, effort: call.effort ?? null, source: "call" };
  const legacy = agentType?.match(legacyAgentRe);
  if (legacy) return { model: legacy[1], effort: legacy[2], source: "agent name" };
  return { model: null, effort: null, source: "inherited" };
}

function check(record, sheet, parentModel) {
  if (!record.role) return "untagged";
  const known = roleNames.get(record.role);
  if (!known) return `unknown role ${record.role}`;
  let expected;
  try {
    expected = resolveRole(sheet, known[0], known[1]);
  } catch (error) {
    return `sheet error: ${error.message}`;
  }
  const native = expected.filter((e) => !e.harness);
  if (!native.length) return `sheet runs this role on ${[...new Set(expected.map((e) => e.harness))].join(", ")}`;
  const want = new Set(native.map((e) => familyOf(e.model ?? parentModel)));
  const got = record.ran.map(familyOf);
  if (got.length && !got.some((f) => want.has(f))) return `ran ${got.join(", ")}, sheet says ${[...want].join(", ")}`;
  return null;
}

export function sessionReport(file, sheet = "") {
  const entries = readJsonl(file);
  const main = spend(entries);
  const calls = agentCalls(entries);
  const dir = join(file.slice(0, -".jsonl".length), "subagents");
  const metas = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".meta.json")).sort() : [];
  const spawns = metas.map((name) => {
    const meta = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const transcript = join(dir, name.replace(/\.meta\.json$/, ".jsonl"));
    const call = calls.get(meta.toolUseId) ?? {};
    const description = call.description ?? meta.description ?? "";
    const record = {
      description,
      role: description.match(tagRe)?.[1].trim() ?? null,
      agentType: meta.agentType ?? call.subagent_type ?? null,
      requested: requested(call, meta.agentType),
      ...(existsSync(transcript) ? spend(readJsonl(transcript)) : { usage: emptyUsage(), ran: [] }),
    };
    return { ...record, issue: check(record, sheet, main.ran[0]) };
  });
  return { session: basename(file, ".jsonl"), modified: statSync(file).mtime.toISOString(), main, spawns };
}

export const transcriptDir = (cwd, configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")) =>
  join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

const inputOf = (u) => u.input + u.cacheWrite + u.cacheRead;
const millions = (n) => (n / 1e6).toFixed(1);
const thousands = (n) => (n / 1e3).toFixed(1);

export function summarize(reports) {
  const rows = new Map();
  for (const spawn of reports.flatMap((r) => r.spawns)) {
    const role = spawn.role ?? `(untagged ${spawn.agentType ?? "agent"})`;
    const key = [role, spawn.ran.join(",") || "-", spawn.requested.effort ?? "session"].join("\t");
    const row = rows.get(key) ?? { n: 0, usage: emptyUsage() };
    row.n += 1;
    for (const k of Object.keys(row.usage)) row.usage[k] += spawn.usage[k];
    rows.set(key, row);
  }
  return [...rows].map(([key, row]) => {
    const [role, ran, effort] = key.split("\t");
    return { role, ran, effort, ...row };
  }).sort((a, b) => b.usage.output - a.usage.output);
}

function render(reports) {
  const parent = emptyUsage();
  for (const r of reports) for (const k of Object.keys(parent)) parent[k] += r.main.usage[k];
  const [only] = reports;
  const scope = reports.length === 1 ? `session ${only.session} (${only.modified.slice(0, 10)})` : `${reports.length} sessions`;
  const out = [`${scope}, main thread: input ${millions(inputOf(parent))}M, output ${thousands(parent.output)}k`];
  out.push("", ["role", "ran", "effort", "spawns", "input (M)", "output (k)"].join("\t"));
  for (const row of summarize(reports)) {
    out.push([row.role, row.ran, row.effort, row.n, millions(inputOf(row.usage)), thousands(row.usage.output)].join("\t"));
  }
  const spawns = reports.flatMap((r) => r.spawns);
  const untagged = spawns.filter((s) => s.issue === "untagged").length;
  const flagged = spawns.filter((s) => s.issue && s.issue !== "untagged");
  out.push("", `routing: ${spawns.length} spawns, ${untagged} untagged, ${flagged.length} off the sheet`);
  for (const s of flagged) out.push(`  ${s.description}: ${s.issue}`);
  return out.join("\n");
}

function main() {
  const { values } = parseArgs({
    options: {
      session: { type: "string" },
      all: { type: "boolean" },
      since: { type: "string" },
      dir: { type: "string" },
      sheet: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const dir = values.dir ?? transcriptDir(process.cwd());
  if (!existsSync(dir)) throw new Error(`No transcripts at ${dir}. Pass --dir with the folder that holds the session transcripts.`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  const byAge = files.map((f) => [f, statSync(f).mtimeMs]).sort((a, b) => b[1] - a[1]);
  let chosen;
  if (values.session) chosen = byAge.filter(([f]) => basename(f).startsWith(values.session));
  else if (values.all || values.since) chosen = byAge.filter(([, t]) => !values.since || t >= Date.parse(values.since));
  else chosen = byAge.slice(0, 1);
  if (!chosen.length) throw new Error(`No session in ${dir} matches.`);
  const projectSheet = join(process.cwd(), ".pstack", "models.md");
  const sheetPath = values.sheet ?? [projectSheet, join(homedir(), ".claude", "pstack-models.md")].find(existsSync);
  const sheet = sheetPath ? readFileSync(sheetPath, "utf8") : "";
  const reports = chosen.map(([f]) => sessionReport(f, sheet));
  console.log(values.json ? JSON.stringify({ sheet: sheetPath ?? null, reports, summary: summarize(reports) }, null, 2) : render(reports));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
