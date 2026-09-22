import { arch as osArch, platform as osPlatform } from "node:os";
import {
  installDirectory,
  installedBinaryPath,
  runningAsInstalledBinary,
} from "./install-binary.js";
import type { BinaryTargetOptions, PluginBinary } from "./models.js";
import { isPublishedTarget, releaseAssetName, resolveTarget } from "./target.js";
import { installFromReleases, installLocalCopy, updateFromGitHub } from "./update.js";

export function defineBinaryTarget(options: BinaryTargetOptions): PluginBinary {
  const target = resolveTarget(options);
  return {
    target,
    supportsHost: (platform = osPlatform(), arch = osArch()) =>
      isPublishedTarget(target, platform, arch),
    assetName: (platform, arch, version) => releaseAssetName(target, platform, arch, version),
    installDirectory: (home) => installDirectory(target, home),
    installedBinaryPath: (home) => installedBinaryPath(target, installDirectory(target, home)),
    isInstalledBinary: (executablePath, home) =>
      runningAsInstalledBinary(
        executablePath,
        installedBinaryPath(target, installDirectory(target, home)),
      ),
    install: (installOptions = {}) => installFromReleases(target, installOptions),
    installLocalCopy: (executablePath, version, hostOptions = {}) =>
      installLocalCopy(target, executablePath, version, hostOptions),
    update: (updateOptions) => updateFromGitHub(target, updateOptions),
  };
}
