import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashExecutable } from "./platform.mjs";

test("decision logger preserves spaced paths, sanitizes cells, and appends one header", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack log "));
  try {
    const file = join(dir, "nested directory", "decisions.tsv");
    const script = join(import.meta.dir, "../plugins/pstack/skills/show-me-your-work/scripts/log.mjs");
    for (let i = 0; i < 2; i++) {
      execFileSync(process.execPath, [script, file, "phase", "=formula", "line\nbreak", "tab\there", "done"]);
    }
    const wrapper = script.replace(/\.mjs$/, ".sh");
    execFileSync(bashExecutable, [wrapper, file, "phase", "decision", "why", "evidence", "done"]);
    const rows = readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe("ts\tphase\tdecision\twhy\tevidence\tresult");
    expect(rows[1].split("\t").slice(1)).toEqual(["phase", "'=formula", "line break", "tab here", "done"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
