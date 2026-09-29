import { parseEntry } from "../../poteto-mode/scripts/resolve-models.mjs";

const NOT_ROLES = new Set(["effort", "session hook"]);

function parseSlot(raw) {
  try {
    const { harness, model, explicitEffort } = parseEntry(raw);
    return { harness: harness ?? "", model, effort: explicitEffort ?? "" };
  } catch {
    return null;
  }
}

export const slotText = ({ harness, model, effort }) => `${harness ? `${harness}:` : ""}${model}${effort ? `@${effort}` : ""}`;

export function parseSheet(text) {
  const lines = text.split(/\r?\n/);
  const roles = [];
  lines.forEach((line, index) => {
    const m = /^([a-z][a-z ,\-]*[a-z]):\s*(\S.*)$/.exec(line);
    if (!m || NOT_ROLES.has(m[1])) return;
    const slots = m[2].split(",").map((entry) => parseSlot(entry));
    if (slots.some((slot) => !slot)) return;
    roles.push({ role: m[1], line: index, slots });
  });
  return { lines, roles };
}
