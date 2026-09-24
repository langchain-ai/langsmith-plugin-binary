import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { arch as osArch, platform as osPlatform } from "node:os";
import { LOCK_FILE_NAME, OLDER_THAN_ANY_RELEASE } from "./constants.js";
import { installDirectory, installRelease, installRunningBinary } from "./install-binary.js";
import { fetchReleases, fetchTaggedRelease, newestRelease } from "./releases.js";
import { configuredReleasesApi, isPublishedTarget } from "./target.js";
import { acquireLock, releaseLock } from "./utils/lock.js";
import { isVersion } from "./utils/version.js";
function releaseQuery(target, currentVersion, options) {
    return {
        target,
        platform: options.runtimePlatform ?? osPlatform(),
        arch: options.runtimeArch ?? osArch(),
        currentVersion,
        releasesApi: options.releasesApi ?? configuredReleasesApi(target, options.environment),
        fetchImpl: options.fetchImpl ?? fetch,
    };
}
function stagingOptions(options) {
    return {
        verifySignature: options.verifySignature,
        now: options.now,
        pause: options.pause,
        versionCheckBudget: options.versionCheckBudget,
    };
}
function resolveInstallDir(target, options) {
    return options.installDir ?? installDirectory(target, options.home);
}
function requirePublishedTarget(target, platform, arch) {
    if (!isPublishedTarget(target, platform, arch)) {
        throw new Error(`the binary does not run on ${platform}-${arch}`);
    }
}
export async function updateFromGitHub(target, options) {
    const query = releaseQuery(target, options.currentVersion, options);
    if (!isPublishedTarget(target, query.platform, query.arch))
        return { status: "unsupported" };
    if (!isVersion(options.currentVersion))
        return { status: "unsupported" };
    const installDir = resolveInstallDir(target, options);
    const lockFile = join(installDir, LOCK_FILE_NAME);
    const now = (options.now ?? Date.now)();
    await mkdir(installDir, { recursive: true, mode: 0o700 });
    const lock = await acquireLock(lockFile, now);
    if (!lock)
        return { status: "busy" };
    try {
        const release = newestRelease(await fetchReleases(query), options.currentVersion);
        if (!release)
            return { status: "current" };
        await installRelease(release, installDir, query, stagingOptions(options));
        return { status: "updated", version: release.version };
    }
    finally {
        await releaseLock(lockFile, lock);
    }
}
async function chooseRelease(query, tag) {
    const release = tag
        ? await fetchTaggedRelease(query, tag)
        : newestRelease(await fetchReleases(query), OLDER_THAN_ANY_RELEASE);
    if (!release) {
        throw new Error(tag
            ? `no published release tagged ${tag} carries a ${query.platform}-${query.arch} binary`
            : `no published release carries a ${query.platform}-${query.arch} binary`);
    }
    return release;
}
export async function installFromReleases(target, options = {}) {
    const query = releaseQuery(target, options.currentVersion ?? OLDER_THAN_ANY_RELEASE, options);
    requirePublishedTarget(target, query.platform, query.arch);
    const release = await chooseRelease(query, options.tag);
    const installDir = resolveInstallDir(target, options);
    const path = await installRelease(release, installDir, query, stagingOptions(options));
    return { path, version: release.version };
}
export async function installLocalCopy(target, executablePath, version, options = {}) {
    const platform = options.runtimePlatform ?? osPlatform();
    const arch = options.runtimeArch ?? osArch();
    requirePublishedTarget(target, platform, arch);
    const installDir = resolveInstallDir(target, options);
    const path = await installRunningBinary(target, executablePath, installDir, version, stagingOptions(options));
    return { path, version };
}
//# sourceMappingURL=update.js.map