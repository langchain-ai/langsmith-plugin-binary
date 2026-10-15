/** Canonical langsmith.json contract. Keep this module dependency-free across adapters. */
export interface CommonReplica {
    api_url?: string;
    api_key?: string;
    project?: string;
    updates?: Record<string, unknown>;
}
export interface CommonRedactRule {
    pattern: string;
    replace?: string;
}
export interface CommonConfig {
    enabled?: boolean;
    defaultMuted?: boolean;
    api_key?: string;
    api_url?: string;
    project?: string;
    replicas?: CommonReplica[];
    metadata?: Record<string, unknown>;
    redact?: boolean;
    redact_extra_rules?: CommonRedactRule[];
}
/** Raw is only for adapter extensions: never re-validate common fields with an extension schema. */
export interface CommonConfigResult {
    status: "absent" | "valid" | "invalid";
    common: CommonConfig;
    raw?: Record<string, unknown>;
    /** Fixed messages only: no file contents, values, parser errors, or secrets. */
    diagnostics: string[];
}
export interface CommonConfigSources {
    /** Adapter supplies exact project and user sources; no ancestor search. */
    harness?: CommonConfig;
    root?: CommonConfig;
    user?: CommonConfig;
    /** Optional home-root baseline, below the adapter-specific user config. */
    userRoot?: CommonConfig;
    /** Already parsed by the adapter's existing environment discovery/parsers. */
    env?: CommonConfig;
    defaults?: CommonConfig;
    managed: CommonConfigResult;
}
export interface MergeCommonConfigOptions {
    envFirst?: boolean;
}
export type MergedCommonConfig = CommonConfig & {
    enabled: boolean;
    defaultMuted: boolean;
    redact: boolean;
    locked: LockableField[];
    diagnostics: string[];
};
export type LockableField = "api_url" | "replicas" | "redact" | "redact_extra_rules";
export interface ManagedConfigFileOptions {
    path?: string;
    ownerUid?: number;
    checkOwnership?: boolean;
}
export interface SdkReplica {
    apiUrl?: string;
    apiKey?: string;
    projectName?: string;
    updates?: Record<string, unknown>;
}
export interface CommonConfigFileOptions {
    cwd: string;
    home: string | undefined;
    harnessDirectory: string;
    managed?: ManagedConfigFileOptions;
}
export interface CommonConfigFiles {
    harness: CommonConfigResult;
    root: CommonConfigResult;
    user: CommonConfigResult;
    userRoot: CommonConfigResult;
    managed: CommonConfigResult;
}
//# sourceMappingURL=models.d.ts.map