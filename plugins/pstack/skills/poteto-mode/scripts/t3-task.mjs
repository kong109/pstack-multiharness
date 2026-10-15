#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { NAME, fill, foreignRequest, protocolPointer } from "./agent-routes.mjs";
import { harnesses } from "./resolve-models.mjs";

const ROLES = { read: "review", write: "implementation" };

export function taskText(brief, access) {
  const scope = access === "read" ? "Do not modify any file." : "Change only what the task assigns.";
  return `${brief.trimEnd()}

## Subagent protocol

You run as a T3 Code subagent. Your parent agent reads only your final message, and nobody can answer a question while you work.

${protocolPointer}

- Never stop at an approval or confirmation prompt to wait for an answer.
- If a decision blocks you, end your turn with a final message whose first line is exactly QUESTION and whose remaining lines hold only the question.
- When the work is complete, your final message is your complete final report. Never end with a status note.
- ${scope}
`;
}

// One resolved foreign entry as the arguments of T3 Code's delegate_task tool. The child inherits the
// parent's runtime mode and T3 Code steps it down to what the provider offers, so no mode is set here.
export function t3Task({ name, harness, model, effort = null, access = "read", brief }) {
  if (!NAME.test(name ?? "")) throw new Error(`--name must match ${NAME}`);
  foreignRequest("t3-task", { harness, model, effort });
  const { t3 } = harnesses[harness];
  if (!t3) throw new Error(`${harness} has no t3 block in harnesses.json, so T3 Code cannot run it`);
  if (!Object.hasOwn(ROLES, access)) throw new Error("--access is read or write");
  if (!brief?.trim()) throw new Error("--brief must name a file with the task in it");
  const options = Object.fromEntries(
    Object.entries(t3.options ?? {})
      .filter(([, template]) => effort !== null || !template.includes("{effort}"))
      .map(([id, template]) => [id, fill([template], { model, effort })[0]]),
  );
  const task = taskText(brief, access);
  const target = { driverKind: t3.driver, model, ...(Object.keys(options).length > 0 && { options }) };
  const digest = createHash("sha256").update(JSON.stringify([target, task])).digest("hex").slice(0, 12);
  return {
    title: name,
    clientRequestId: `pstack-${name}-${digest}`,
    mode: "async",
    role: ROLES[access],
    target,
    task,
  };
}

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" }, harness: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
      access: { type: "string" }, brief: { type: "string" },
    },
  });
  if (!values.brief || !existsSync(values.brief)) throw new Error("--brief must name an existing file");
  const { brief: file, effort, ...rest } = values;
  return t3Task({ ...rest, effort: effort ?? null, brief: readFileSync(file, "utf8") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
