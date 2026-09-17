import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const gitExecutable = Bun.which("git");
if (!gitExecutable) throw new Error("Git must be available on PATH");

function findBash() {
  if (process.platform !== "win32") return "bash";
  const gitCore = execFileSync(gitExecutable, ["--exec-path"], { encoding: "utf8" }).trim();
  const candidates = [
    resolve(dirname(gitExecutable), "../bin/bash.exe"),
    resolve(gitCore, "../../../bin/bash.exe"),
  ];
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error("Install Git for Windows with Git Bash to run shell helper tests");
  return executable;
}

export const bashExecutable = findBash();
export const shellPath = (path) => path.replaceAll("\\", "/")
  .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
