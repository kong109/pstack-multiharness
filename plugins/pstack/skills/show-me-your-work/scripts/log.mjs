#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [file, ...cells] = process.argv.slice(2);
if (!file || cells.length !== 5) {
  console.error("usage: node log.mjs <logfile> <phase> <decision> <why> <evidence> <result>");
  process.exit(1);
}
const clean = (cell) => {
  const value = cell.replace(/[\t\n\r]/g, " ");
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
};
mkdirSync(dirname(file), { recursive: true });
const header = existsSync(file) ? "" : "ts\tphase\tdecision\twhy\tevidence\tresult\n";
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
appendFileSync(file, `${header}${[timestamp, ...cells.map(clean)].join("\t")}\n`, "utf8");
