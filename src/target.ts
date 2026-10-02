import { DEFAULT_PUBLISHED_TARGETS } from "./constants.js";
import type { BinaryTarget, BinaryTargetOptions } from "./models.js";

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
