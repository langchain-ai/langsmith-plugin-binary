import { arch as osArch, platform as osPlatform } from "node:os";
import { isPublishedTarget, releaseAssetName, resolveTarget } from "./target.js";
export function defineBinaryTarget(options) {
    const target = resolveTarget(options);
    return {
        target,
        supportsHost: (platform = osPlatform(), arch = osArch()) => isPublishedTarget(target, platform, arch),
        assetName: (platform, arch, version) => releaseAssetName(target, platform, arch, version),
    };
}
//# sourceMappingURL=binary.js.map