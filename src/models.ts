import type { APPLE_CREDENTIALS } from "./constants.js";

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

export interface BuildConfig {
  entryPoint: string;
  outputDirectory: string;
  versionFile: string;
  minify: boolean;
  defines: Record<string, string>;
}

export interface SignConfig {
  entitlements: string;
}

export interface PluginBinaryConfig {
  executableName: string;
  repository: string;
  publishedTargets: Readonly<Record<string, readonly string[]>>;
  installer: InstallerConfig;
  build: BuildConfig;
  sign: SignConfig;
}

export interface LoadedConfig {
  config: PluginBinaryConfig;
  repositoryRoot: string;
}

export type BinaryTargetOptions = Omit<BinaryTarget, "publishedTargets" | "installDirectoryName"> &
  Partial<Pick<BinaryTarget, "publishedTargets" | "installDirectoryName">>;

export interface PluginBinary {
  target: BinaryTarget;
  supportsHost(platform?: string, arch?: string): boolean;
  assetName(platform: string, arch: string, version: string): string;
  installDirectory(home?: string): string;
  installedBinaryPath(home?: string): string;
  isInstalledBinary(executablePath: string, home?: string): Promise<boolean>;
  install(options?: InstallOptions): Promise<InstalledBinary>;
  installLocalCopy(
    executablePath: string,
    version: string,
    options?: HostOptions,
  ): Promise<InstalledBinary>;
  update(options: UpdateOptions): Promise<UpdateResult>;
}

export interface ExecFileFailure {
  killed?: boolean | undefined;
  signal?: string | null | undefined;
  code?: number | string | null | undefined;
}

export type VersionCheckFailure =
  | { kind: "stopped"; signal: string }
  | { kind: "crashed"; signal: string }
  | { kind: "timeout"; seconds: number }
  | { kind: "exit"; status: number }
  | { kind: "start"; detail: string }
  | { kind: "unclear"; detail: string };

export type VersionCheck =
  | { ok: true; reported: string }
  | { ok: false; failure: VersionCheckFailure };

export type SignatureVerifier = (binary: string) => Promise<void>;

export type Pause = (milliseconds: number) => Promise<void>;

export interface StagingOptions {
  verifySignature?: SignatureVerifier | undefined;
  now?: (() => number) | undefined;
  pause?: Pause | undefined;
  versionCheckBudget?: number | undefined;
}

export interface StagingPlan {
  target: BinaryTarget;
  installDir: string;
  version: string;
  options: StagingOptions;
  fill: (temporary: string) => Promise<void>;
  confirmVersion: boolean;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest: string | null;
}

export interface InstallableRelease {
  version: string;
  asset: ReleaseAsset;
  checksum: ReleaseAsset | undefined;
}

export interface ReleaseQuery {
  target: BinaryTarget;
  platform: string;
  arch: string;
  currentVersion: string;
  releasesApi: string;
  fetchImpl: typeof fetch;
}

export interface ParsedVersion {
  numbers: [number, number, number];
  final: number;
  label: string;
  iteration: number;
}

export type UpdateResult =
  | { status: "unsupported" | "busy" | "current" }
  | { status: "updated"; version: string };

export interface HostOptions {
  runtimePlatform?: string | undefined;
  runtimeArch?: string | undefined;
  installDir?: string | undefined;
  home?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  releasesApi?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  verifySignature?: SignatureVerifier | undefined;
  now?: (() => number) | undefined;
  pause?: Pause | undefined;
  versionCheckBudget?: number | undefined;
}

export interface UpdateOptions extends HostOptions {
  currentVersion: string;
}

export interface InstallOptions extends HostOptions {
  tag?: string | undefined;
  currentVersion?: string | undefined;
}

export interface InstalledBinary {
  path: string;
  version: string;
}

export interface BuildPlan {
  platform: string;
  arches: readonly string[];
  entryPoint: string;
  outputDirectory: string;
  executableName: string;
  version: string;
  minify: boolean;
  defines: Record<string, string>;
}

export interface BuildSteps {
  compile(plan: BuildPlan, arch: string, binary: string, repositoryRoot: string): void;
  checkArch(binary: string, arch: string): void;
  signAdHoc(binary: string): void;
  checkVersion(binary: string, version: string): void;
}

export type CredentialName = (typeof APPLE_CREDENTIALS)[number];
export type Environment = Partial<Record<CredentialName, string>>;
export type AppleCredentials = Record<CredentialName, string>;
