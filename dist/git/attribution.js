import { isAbsolute } from "node:path";
import { REPOSITORY_METADATA_KEYS } from "../metadata/constants.js";
import { nearestExistingDirectory } from "../utils/paths.js";
import { createGitHubLoginFallback } from "./github-login.js";
import { rootFromGitMarker } from "./paths.js";
import { getGitUserName, getRepoRoot, getRepositoryMetadata } from "./repository.js";
export function createRepositoryAttributor(options) {
    const rootByDirectory = new Map();
    const attributionByRoot = new Map();
    const identifierByRoot = new Map();
    const githubLogin = createGitHubLoginFallback({ markerPath: options.githubLoginMarkerPath });
    function rootForPath(path) {
        const directory = nearestExistingDirectory(path);
        if (!directory)
            return undefined;
        if (rootByDirectory.has(directory))
            return rootByDirectory.get(directory);
        const walked = rootFromGitMarker(directory);
        const onlyGitCanSay = walked === undefined;
        const root = onlyGitCanSay ? getRepoRoot(directory) : walked;
        rootByDirectory.set(directory, root);
        return root;
    }
    function isSessionsOwnRepository(sessionCwd, root) {
        return sessionCwd ? rootForPath(sessionCwd) === root : false;
    }
    function identifierForRoot(root) {
        const cached = identifierByRoot.get(root);
        if (cached)
            return cached;
        const userName = getGitUserName(root, { githubLogin });
        const identifier = userName
            ? { ls_attribution_identifier: userName }
            : {};
        identifierByRoot.set(root, identifier);
        return identifier;
    }
    function attributionForRoot(root) {
        const cached = attributionByRoot.get(root);
        if (cached)
            return cached;
        const attribution = {
            ...identifierForRoot(root),
            ...getRepositoryMetadata(root),
        };
        attributionByRoot.set(root, attribution);
        return attribution;
    }
    function scopedToPath(base, origin, pinned) {
        const namedSomewhereNothingSits = origin.namedAPath && !origin.path;
        if (namedSomewhereNothingSits)
            return base;
        const path = origin.path ?? origin.cwd;
        if (!path || !isAbsolute(path))
            return base;
        const root = rootForPath(path);
        const gitCouldNotAnswer = root === undefined;
        if (gitCouldNotAnswer)
            return base;
        const pathIsInNoRepository = root === null;
        if (pathIsInNoRepository)
            return withoutRepositoryKeys(base, pinned);
        if (isSessionsOwnRepository(origin.cwd, root)) {
            return { ...base, ...withoutPinnedKeys(identifierForRoot(root), pinned) };
        }
        return {
            ...withoutRepositoryKeys(base, pinned),
            ...withoutPinnedKeys(attributionForRoot(root), pinned),
        };
    }
    function withSessionRepository(base, sessionCwd) {
        const sessionRoot = sessionCwd ? rootForPath(sessionCwd) : undefined;
        if (typeof sessionRoot !== "string")
            return base;
        return { ...attributionForRoot(sessionRoot), ...base };
    }
    function toolMetadata(base, origin) {
        const pinned = new Set(REPOSITORY_METADATA_KEYS.filter((key) => base?.[key] !== undefined));
        return scopedToPath(withSessionRepository(base, origin.cwd), origin, pinned);
    }
    function turnMetadata(base, cwd, toolOrigins) {
        const sessionCwd = cwd ? { cwd } : {};
        const sessionRoot = cwd ? rootForPath(cwd) : undefined;
        if (typeof sessionRoot === "string") {
            return toolMetadata(base, { ...sessionCwd, namedAPath: false });
        }
        for (const { path, namedAPath } of toolOrigins) {
            if (!path)
                continue;
            const landedInRepository = typeof rootForPath(path) === "string";
            if (landedInRepository)
                return toolMetadata(base, { path, namedAPath, ...sessionCwd });
        }
        return base;
    }
    return { toolMetadata, turnMetadata };
}
function withoutPinnedKeys(attribution, pinned) {
    if (pinned.size === 0)
        return { ...attribution };
    return Object.fromEntries(Object.entries(attribution).filter(([key]) => !pinned.has(key)));
}
function withoutRepositoryKeys(base, pinned) {
    const stripped = { ...base };
    for (const key of REPOSITORY_METADATA_KEYS) {
        if (!pinned.has(key))
            delete stripped[key];
    }
    return stripped;
}
//# sourceMappingURL=attribution.js.map