import { parseEntry } from "../../poteto-mode/scripts/resolve-models.mjs";

const NOT_ROLES = new Set(["default effort", "session hook"]);

function parseSlot(raw) {
  try {
    const { harness, model, explicitEffort } = parseEntry(raw);
    return { harness: harness ?? "", model, effort: explicitEffort ?? "" };
  } catch {
    return null;
  }
}

export const slotText = ({ harness, model, effort }) => `${harness ? `${harness}:` : ""}${model}${effort ? ` @${effort}` : ""}`;

const ROLE_LINE = /^([a-z][a-z ,\-]*[a-z]):\s*(\S.*)$/;

export const allRoleLabels = (text) =>
  text.split(/\r?\n/).map((line) => ROLE_LINE.exec(line)?.[1]).filter((role) => role && !NOT_ROLES.has(role));

export function parseSheet(text) {
  const lines = text.split(/\r?\n/);
  const roles = [];
  let defaultEffort = "";
  lines.forEach((line, index) => {
    const fallback = /^default effort:\s*(\S+)\s*$/.exec(line);
    if (fallback) defaultEffort = fallback[1] === "session" ? "" : fallback[1];
    const m = ROLE_LINE.exec(line);
    if (!m || NOT_ROLES.has(m[1])) return;
    const slots = m[2].split(",").map(parseSlot);
    if (slots.some((slot) => !slot)) return;
    roles.push({ role: m[1], line: index, slots });
  });
  return { lines, roles, defaultEffort };
}
