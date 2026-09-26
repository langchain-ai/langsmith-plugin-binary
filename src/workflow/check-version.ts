import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConfig } from "../config.js";
import { stampsVersion } from "../utils/version.js";

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
for (const named of build.stampedVersionFiles) {
  const file = join(dirname(CONFIG), named);
  if (!stampsVersion(readFileSync(file, "utf8"), TAG)) {
    console.error(`${file} was not built at ${TAG}. Rebuild it, commit it, then retag.`);
    disagrees = true;
  }
}
if (disagrees) process.exit(1);
