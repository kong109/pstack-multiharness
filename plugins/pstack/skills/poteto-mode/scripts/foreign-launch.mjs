import { fileURLToPath } from "node:url";

import { effortsOn, harnesses, takesEffort } from "./resolve-models.mjs";

export const skill = fileURLToPath(new URL("../SKILL.md", import.meta.url));
export const worker = fileURLToPath(new URL("../worker.md", import.meta.url));

export const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_./:-]*$/;
const WORKER_KICKOFF_LINE = /^read\s+["'`]?(?:[^\r\n"'`]*[/\\])?worker\.md["'`]?\s+before\s+anything\s+else\.?$/i;

export const fill = (template, vars) =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (_, key) => vars[key]));

export const workerKickoff = `Read ${worker} before anything else.`;

export function withWorkerKickoff(brief) {
  const trimmed = brief.trimEnd();
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
  if (WORKER_KICKOFF_LINE.test(firstLine)) return trimmed;
  const body = trimmed.trimStart();
  return body ? `${workerKickoff}\n\n${body}` : workerKickoff;
}

export const protocolPointer = `Read the poteto-mode instructions at ${skill} before working. If the task supplies a specialist prompt or reference, read it and preserve that specialty. Report evidence and limitations accurately.`;

export function checkForeignTarget(label, { harness, model, effort }) {
  const efforts = effortsOn(harness, model);
  if (effort !== null && !takesEffort(harness)) {
    throw new Error(`${harness} takes no effort setting; name the effort in the model id (${model}-${effort}) for ${label}`);
  }
  if (effort !== null && efforts && !efforts.includes(effort)) {
    throw new Error(`Unsupported ${harness} effort for ${label}: ${effort} (use ${efforts.join(", ")})`);
  }
}

export function checkForeignRequest(label, { harness, model, effort = null }) {
  if (!Object.hasOwn(harnesses, harness ?? "")) throw new Error(`--harness must be one of ${Object.keys(harnesses).join(", ")}`);
  if (!TOKEN.test(model ?? "")) throw new Error("--model is required and may hold only letters, digits, and . _ / : -");
  if (effort !== null && !TOKEN.test(effort)) throw new Error("--effort may hold only letters, digits, and . _ / : -");
  checkForeignTarget(label, { harness, model, effort });
}
