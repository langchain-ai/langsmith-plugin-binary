import type { APPLE_CREDENTIALS } from "./constants.js";
export interface BinaryTarget {
    executableName: string;
    repository: string;
    userAgent: string;
    releasesApiOverrideEnvVar: string;
    publishedTargets: Readonly<Record<string, readonly string[]>>;
}
export interface BuildConfig {
    entryPoint: string;
    outputDirectory: string;
    versionFile: string;
    matchingVersionFiles: string[];
    stampedVersionFiles: string[];
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
    build: BuildConfig;
    sign: SignConfig;
}
export interface LoadedConfig {
    config: PluginBinaryConfig;
    repositoryRoot: string;
}
export type BinaryTargetOptions = Omit<BinaryTarget, "publishedTargets"> & Partial<Pick<BinaryTarget, "publishedTargets">>;
export interface PluginBinary {
    target: BinaryTarget;
    supportsHost(platform?: string, arch?: string): boolean;
    assetName(platform: string, arch: string, version: string): string;
}
export interface ExecFileFailure {
    killed?: boolean | undefined;
    signal?: string | null | undefined;
    code?: number | string | null | undefined;
}
export type VersionCheckFailure = {
    kind: "stopped";
    signal: string;
} | {
    kind: "crashed";
    signal: string;
} | {
    kind: "timeout";
    seconds: number;
} | {
    kind: "exit";
    status: number;
} | {
    kind: "start";
    detail: string;
} | {
    kind: "unclear";
    detail: string;
};
export type VersionCheck = {
    ok: true;
    reported: string;
} | {
    ok: false;
    failure: VersionCheckFailure;
};
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
//# sourceMappingURL=models.d.ts.map