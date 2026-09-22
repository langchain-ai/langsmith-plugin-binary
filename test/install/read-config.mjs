import { readFileSync } from "node:fs";

const [configPath, dottedPath] = process.argv.slice(2);
if (!configPath || !dottedPath) {
  console.error("usage: read-config.mjs <binary.config.json> <dotted.path>");
  process.exit(2);
}

let value = JSON.parse(readFileSync(configPath, "utf-8"));
for (const key of dottedPath.split(".")) {
  value = value?.[key];
}
if (value === undefined) {
  console.error(`${configPath} has no ${dottedPath}`);
  process.exit(2);
}

process.stdout.write(Array.isArray(value) ? value.join("\n") : String(value));
