export interface BinaryTarget {
  executableName: string;
  repository: string;
  installDirectoryName: string;
  userAgent: string;
  releasesApiOverrideEnvVar: string;
  publishedTargets: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_PUBLISHED_TARGETS: Readonly<Record<string, readonly string[]>> = {
  darwin: ["arm64", "x64"],
};
