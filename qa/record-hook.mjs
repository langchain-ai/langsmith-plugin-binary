import { appendFileSync, readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(process.argv[2], `${payload.hook_event_name}\n`);
