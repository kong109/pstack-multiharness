import { expect, test } from "bun:test";
import { parseWorktrees } from "../plugins/pstack/skills/poteto-mode/scripts/worktree-records.mjs";

test("Git records preserve quoted paths, Windows separators, and prunable state", () => {
  expect(parseWorktrees('worktree C:/source/repo with spaces\r\nHEAD abc\r\n\r\nworktree "C:\\\\abc\\\\view"\r\nprunable missing\r\n')).toEqual([
    { path: "C:/source/repo with spaces", state: "ok" },
    { path: "C:\\abc\\view", state: "prunable" },
  ]);
  expect(parseWorktrees('worktree "/tmp/quote\\\"tab\\tline\\nalert\\aescape\\033"\nHEAD abc\n')[0].path)
    .toBe('/tmp/quote"tab\tline\nalert\x07escape\x1b');
});

test("empty or malformed Git output fails instead of producing a successful empty audit", () => {
  for (const text of ["", "HEAD abc\n", 'worktree "unterminated\n']) {
    expect(() => parseWorktrees(text)).toThrow();
  }
});
