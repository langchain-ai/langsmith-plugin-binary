import { readFileSync, writeFileSync } from "node:fs";

const [output] = process.argv.slice(2);
const file = process.env.NODE_EXTRA_CA_CERTS ?? "";
writeFileSync(output, `${file}\n${file === "" ? "" : readFileSync(file, "utf8")}`);
