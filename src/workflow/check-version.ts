import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConfig } from "../config.js";

const CONFIG = process.env.CONFIG as string;
const TAG = process.env.TAG as string;

const { build } = parseConfig(JSON.parse(readFileSync(CONFIG, "utf8")));
let disagrees = false;
for (const named of [build.versionFile, ...build.matchingVersionFiles]) {
  const file = join(dirname(CONFIG), named);
  const { version } = JSON.parse(readFileSync(file, "utf8"));
  if (version !== TAG) {
    console.error(`${file} is ${version} but the tag is ${TAG}. Bump the version, then retag.`);
    disagrees = true;
  }
}
if (disagrees) process.exit(1);
