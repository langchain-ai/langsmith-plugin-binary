export interface BinaryTarget {
  executableName: string;
  repository: string;
  installDirectoryName: string;
  userAgent: string;
  releasesApiOverrideEnvVar: string;
  publishedTargets: Readonly<Record<string, readonly string[]>>;
}

export interface InstallerConfig {
  productName: string;
  shortUrl: string;
  environmentPrefix: string;
  output: string;
  helpFooter: string[];
  unsupportedPlatformHelp: string[];
}

export interface PluginBinaryConfig {
  executableName: string;
  repository: string;
  installer: InstallerConfig;
}

export interface LoadedConfig {
  config: PluginBinaryConfig;
  repositoryRoot: string;
}
