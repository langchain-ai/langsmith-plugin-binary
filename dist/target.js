import { DEFAULT_PUBLISHED_TARGETS } from "./constants.js";
export function resolveTarget(options) {
    for (const field of ["executableName", "repository", "userAgent"]) {
        if (typeof options[field] !== "string" || options[field].trim() === "") {
            throw new Error(`the binary target needs a ${field}`);
        }
    }
    return {
        executableName: options.executableName,
        repository: options.repository,
        userAgent: options.userAgent,
        releasesApiOverrideEnvVar: options.releasesApiOverrideEnvVar,
        publishedTargets: options.publishedTargets ?? DEFAULT_PUBLISHED_TARGETS,
    };
}
export function isPublishedTarget(target, platform, arch) {
    return target.publishedTargets[platform]?.includes(arch) ?? false;
}
export function releaseAssetName(target, platform, arch, version) {
    return `${target.executableName}-${platform}-${arch}-${version}`;
}
//# sourceMappingURL=target.js.map