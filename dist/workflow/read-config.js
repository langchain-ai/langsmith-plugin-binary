import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const CONFIG = process.env.CONFIG;
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;
const config = JSON.parse(readFileSync(CONFIG, "utf8"));
const targets = config.publishedTargets ?? { darwin: ["arm64", "x64"] };
if (JSON.stringify(targets) !== JSON.stringify({ darwin: ["arm64", "x64"] })) {
    console.error(`This workflow builds macOS arm64 and x64 only. ${CONFIG} asks for ${JSON.stringify(targets)}.`);
    process.exit(1);
}
const executable = config.executableName;
const directory = join(dirname(CONFIG), config.build.outputDirectory);
appendFileSync(GITHUB_OUTPUT, [
    `executable=${executable}`,
    `output-directory=${directory}`,
    `host-binary=${directory}/${executable}`,
    `cross-binary=${directory}/darwin-x64/${executable}`,
    "",
].join("\n"));
//# sourceMappingURL=read-config.js.map