import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { VERSION_DEFINE } from "./constants.js";
import { checkBuiltArch, checkReportedVersion } from "./utils/binary-checks.js";
import { readVersion } from "./utils/fs.js";
import { signAdHoc } from "./utils/process.js";
export function buildPlan({ config, repositoryRoot }) {
    const { build: buildConfig } = config;
    const platforms = Object.keys(config.publishedTargets);
    if (platforms.length !== 1) {
        throw new Error(`the build handles one platform at a time, not ${platforms.length}`);
    }
    const platform = platforms[0];
    const version = readVersion(repositoryRoot, buildConfig.versionFile);
    const defines = { [VERSION_DEFINE]: version };
    for (const [name, file] of Object.entries(buildConfig.defines)) {
        defines[name] = readFileSync(resolve(repositoryRoot, file), "utf-8");
    }
    return {
        platform,
        arches: config.publishedTargets[platform],
        entryPoint: resolve(repositoryRoot, buildConfig.entryPoint),
        outputDirectory: resolve(repositoryRoot, buildConfig.outputDirectory),
        executableName: config.executableName,
        version,
        minify: buildConfig.minify,
        defines,
    };
}
export function requestedArches(plan, argv) {
    const requested = argv.find((arg) => arg.startsWith("--arch="))?.slice("--arch=".length);
    if (requested === "all")
        return [...plan.arches];
    const arch = requested ?? process.arch;
    if (!plan.arches.includes(arch)) {
        throw new Error(`Unsupported architecture ${arch}, expected one of ${[...plan.arches, "all"].join(", ")}`);
    }
    return [arch];
}
export function outputPath(plan, arch) {
    if (arch === process.arch)
        return join(plan.outputDirectory, plan.executableName);
    return join(plan.outputDirectory, `${plan.platform}-${arch}`, plan.executableName);
}
export function buildArguments(plan, arch, binary) {
    return [
        "build",
        "--compile",
        `--target=bun-${plan.platform}-${arch}`,
        ...(plan.minify ? ["--minify"] : []),
        ...Object.entries(plan.defines).flatMap(([name, value]) => [
            "--define",
            `${name}=${JSON.stringify(value)}`,
        ]),
        plan.entryPoint,
        "--outfile",
        binary,
    ];
}
const buildSteps = {
    compile(plan, arch, binary, repositoryRoot) {
        execFileSync("bun", buildArguments(plan, arch, binary), {
            cwd: repositoryRoot,
            stdio: "inherit",
        });
    },
    checkArch: checkBuiltArch,
    signAdHoc,
    checkVersion: checkReportedVersion,
};
export function build(loaded, argv, log = console.log, steps = buildSteps) {
    const plan = buildPlan(loaded);
    if (process.platform !== plan.platform) {
        throw new Error(`Unsupported build host ${process.platform}, only ${plan.platform} is built`);
    }
    for (const arch of requestedArches(plan, argv)) {
        const binary = outputPath(plan, arch);
        mkdirSync(dirname(binary), { recursive: true });
        rmSync(binary, { force: true });
        steps.compile(plan, arch, binary, loaded.repositoryRoot);
        steps.checkArch(binary, arch);
        steps.signAdHoc(binary);
        if (arch === process.arch)
            steps.checkVersion(binary, plan.version);
        log(`Built the ${plan.platform}-${arch} binary ${binary} (${statSync(binary).size} bytes, version ${plan.version})`);
    }
}
//# sourceMappingURL=build.js.map