import { LIST_TIMEOUT_MS } from "./constants.js";
import { githubRequestHeaders, releaseAssetName } from "./target.js";
import { listedReleasesUrl, taggedReleaseUrl } from "./utils/http.js";
import { isVersion, isVersionNewer } from "./utils/version.js";
function asAsset(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const asset = value;
    if (typeof asset.name !== "string")
        return undefined;
    if (typeof asset.browser_download_url !== "string")
        return undefined;
    if (typeof asset.size !== "number")
        return undefined;
    if (asset.digest != null && typeof asset.digest !== "string")
        return undefined;
    return {
        name: asset.name,
        browser_download_url: asset.browser_download_url,
        size: asset.size,
        digest: typeof asset.digest === "string" ? asset.digest : null,
    };
}
function asInstallableRelease(value, target, platform, arch, allowPrerelease) {
    if (!value || typeof value !== "object")
        return undefined;
    const release = value;
    if (release.draft === true)
        return undefined;
    if (release.prerelease === true && !allowPrerelease)
        return undefined;
    if (typeof release.tag_name !== "string" || !Array.isArray(release.assets))
        return undefined;
    const version = release.tag_name.trim();
    if (!isVersion(version))
        return undefined;
    const wanted = releaseAssetName(target, platform, arch, version);
    const assets = release.assets.map(asAsset).filter((asset) => asset !== undefined);
    const asset = assets.find((candidate) => candidate.name === wanted);
    if (!asset)
        return undefined;
    return {
        version,
        asset,
        checksum: assets.find((candidate) => candidate.name === `${wanted}.sha256`),
    };
}
export function parseReleases(value, target, platform, arch, allowPrerelease = false) {
    if (!Array.isArray(value))
        throw new Error("GitHub returned no list of releases");
    return value
        .map((entry) => asInstallableRelease(entry, target, platform, arch, allowPrerelease))
        .filter((release) => release !== undefined);
}
export function newestRelease(releases, currentVersion) {
    let newest;
    for (const release of releases) {
        if (!isVersionNewer(release.version, currentVersion))
            continue;
        if (!newest || isVersionNewer(release.version, newest.version))
            newest = release;
    }
    return newest;
}
async function readJson(query, url, wanted) {
    const response = await query.fetchImpl(url, {
        headers: githubRequestHeaders(query.target, query.currentVersion),
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`failed to read ${wanted}: HTTP ${response.status}`);
    return response.json();
}
export async function fetchReleases(query) {
    const url = listedReleasesUrl(query.releasesApi);
    const listed = await readJson(query, url, "the GitHub releases");
    return parseReleases(listed, query.target, query.platform, query.arch);
}
export async function fetchTaggedRelease(query, tag) {
    const url = taggedReleaseUrl(query.releasesApi, tag);
    const tagged = await readJson(query, url, `the GitHub release tagged ${tag}`);
    return parseReleases([tagged], query.target, query.platform, query.arch, true)[0];
}
//# sourceMappingURL=releases.js.map