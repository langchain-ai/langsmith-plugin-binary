import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_PUBLISHED_TARGETS, ENVIRONMENT_PREFIX, EXECUTABLE_NAME, REPOSITORY_PATH, } from "./constants.js";
import { describe } from "./utils/errors.js";
import { fail, Section } from "./utils/validation.js";
function parseInstaller(root) {
    const installer = root.section("installer");
    return {
        productName: installer.text("productName"),
        shortUrl: installer.text("shortUrl"),
        environmentPrefix: installer.matching("environmentPrefix", ENVIRONMENT_PREFIX, "an upper-case shell variable name"),
        output: installer.repositoryPath("output"),
        helpFooter: installer.lines("helpFooter"),
        unsupportedPlatformHelp: installer.lines("unsupportedPlatformHelp"),
    };
}
function parseBuild(root) {
    const build = root.section("build");
    const defines = {};
    if (build.raw("defines") !== undefined) {
        const declared = build.section("defines");
        for (const [name] of declared.fields()) {
            if (!/^__[A-Z0-9_]+__$/.test(name))
                fail(`build.defines.${name}`, "named like __EXAMPLE__");
            defines[name] = declared.repositoryPath(name);
        }
    }
    const minify = build.raw("minify");
    if (minify !== undefined && typeof minify !== "boolean")
        fail("build.minify", "true or false");
    return {
        entryPoint: build.repositoryPath("entryPoint"),
        outputDirectory: build.repositoryPath("outputDirectory"),
        versionFile: build.repositoryPath("versionFile"),
        matchingVersionFiles: build.raw("matchingVersionFiles") === undefined
            ? []
            : build.repositoryPaths("matchingVersionFiles"),
        stampedVersionFiles: build.raw("stampedVersionFiles") === undefined
            ? []
            : build.repositoryPaths("stampedVersionFiles"),
        minify: minify === true,
        defines,
    };
}
function parsePublishedTargets(root) {
    if (root.raw("publishedTargets") === undefined)
        return DEFAULT_PUBLISHED_TARGETS;
    const targets = root.section("publishedTargets");
    const parsed = {};
    for (const [platform] of targets.fields()) {
        parsed[platform] = targets.strings(platform);
    }
    return parsed;
}
export function parseConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("the binary config must be a JSON object");
    }
    const root = new Section(raw);
    return {
        executableName: root.matching("executableName", EXECUTABLE_NAME, "a lower-case name made of letters, digits and single dashes"),
        repository: root.matching("repository", REPOSITORY_PATH, "an owner/name repository path"),
        publishedTargets: parsePublishedTargets(root),
        installer: parseInstaller(root),
        build: parseBuild(root),
        sign: { entitlements: root.section("sign").repositoryPath("entitlements") },
    };
}
export function loadConfig(configPath) {
    const absolute = resolve(configPath);
    let raw;
    try {
        raw = JSON.parse(readFileSync(absolute, "utf-8"));
    }
    catch (error) {
        throw new Error(`could not read the binary config at ${absolute}: ${describe(error)}`, {
            cause: error,
        });
    }
    return { config: parseConfig(raw), repositoryRoot: dirname(absolute) };
}
//# sourceMappingURL=config.js.map