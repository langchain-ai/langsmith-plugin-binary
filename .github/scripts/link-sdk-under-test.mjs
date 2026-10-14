import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const link = resolve("src/node_modules/langsmith");
const target = join(process.env.RUNNER_TEMP, "sdk-under-test", "node_modules", "langsmith");

mkdirSync(dirname(link), { recursive: true });
symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
