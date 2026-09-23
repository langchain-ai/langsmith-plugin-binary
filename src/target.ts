import { DEFAULT_INSTALL_DIRECTORY_NAME, DEFAULT_PUBLISHED_TARGETS } from "./constants.js";
import type { BinaryTarget, BinaryTargetOptions } from "./models.js";
import { pointsAtThisMachine } from "./utils/http.js";

export function resolveTarget(options: BinaryTargetOptions): BinaryTarget {
  for (const field of ["executableName", "repository", "userAgent"] as const) {
    if (typeof options[field] !== "string" || options[field].trim() === "") {
      throw new Error(`the binary target needs a ${field}`);
    }
  }
  return {
    executableName: options.executableName,
    repository: options.repository,
    userAgent: options.userAgent,
    releasesApiOverrideEnvVar: options.releasesApiOverrideEnvVar,
    installDirectoryName: options.installDirectoryName ?? DEFAULT_INSTALL_DIRECTORY_NAME,
    publishedTargets: options.publishedTargets ?? DEFAULT_PUBLISHED_TARGETS,
  };
}

export function isPublishedTarget(target: BinaryTarget, platform: string, arch: string): boolean {
  return target.publishedTargets[platform]?.includes(arch) ?? false;
}

export function releaseAssetName(
  target: BinaryTarget,
  platform: string,
  arch: string,
  version: string,
): string {
  return `${target.executableName}-${platform}-${arch}-${version}`;
}

export function defaultReleasesApi(target: BinaryTarget): string {
  return `https://api.github.com/repos/${target.repository}/releases`;
}

export function releaseDownloadPrefix(target: BinaryTarget): string {
  return `https://github.com/${target.repository}/releases/download/`;
}

export function githubRequestHeaders(
  target: BinaryTarget,
  currentVersion: string,
): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": `${target.userAgent}/${currentVersion}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function configuredReleasesApi(target: BinaryTarget, environment = process.env): string {
  const override = environment[target.releasesApiOverrideEnvVar];
  if (override && pointsAtThisMachine(override)) return override;
  return defaultReleasesApi(target);
}
