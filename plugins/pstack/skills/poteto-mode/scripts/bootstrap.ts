import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// This tooling is bun-only (import.meta.dir, Bun.spawnSync, bun.lock). Fail with a
// clear message instead of an opaque `import.meta.dir is undefined` crash under node.
if (typeof Bun === "undefined") {
  console.error(
    "pstack poteto-mode tooling requires bun (https://bun.sh). Install bun, then re-run."
  );
  process.exit(1);
}

const scriptsDirectory = import.meta.dir;
const nodeModulesDirectory = join(scriptsDirectory, "node_modules");
const requiredPackages = ["commander", "cross-spawn"];
const dependenciesPresent = () => requiredPackages.every((name) =>
  existsSync(join(nodeModulesDirectory, name, "package.json"))
);
const installKeyPath = join(
  nodeModulesDirectory,
  ".poteto-mode-tools-install-key"
);

function currentInstallKey(): string {
  return createHash("sha256")
    .update(readFileSync(join(scriptsDirectory, "package.json")))
    .update("\0")
    .update(readFileSync(join(scriptsDirectory, "bun.lock")))
    .digest("hex");
}

export function ensureDependenciesInstalled(): void {
  const installKey = currentInstallKey();
  if (
    dependenciesPresent() &&
    existsSync(installKeyPath) &&
    readFileSync(installKeyPath, "utf8").trim() === installKey
  ) {
    return;
  }

  const result = Bun.spawnSync(
    [process.execPath, "install", "--frozen-lockfile", "--production"],
    { cwd: scriptsDirectory }
  );
  if (result.exitCode !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(
      `bun install --frozen-lockfile exited with status ${result.exitCode}`
    );
  }
  if (!dependenciesPresent()) {
    throw new Error(
      "bun install --frozen-lockfile completed without installing required packages"
    );
  }

  writeFileSync(installKeyPath, `${installKey}\n`);

  // Bun can cache a missing node_modules directory before the install runs.
  // Restart once after installation so imports use a fresh resolver cache.
  const restarted = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(restarted.exitCode);
}
