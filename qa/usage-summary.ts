import { readFileSync } from "node:fs";
import { usageSummary, usagesFromLog } from "./replay/usage.ts";

const usages = process.argv.slice(2).flatMap((file) => usagesFromLog(readFileSync(file, "utf8")));
if (usages.length === 0) throw new Error("no usage lines found in the given replay logs");
console.log(usageSummary(usages));
