import type { CommonConfigResult, CommonConfigSources, CommonReplica, MergeCommonConfigOptions, MergedCommonConfig, SdkReplica } from "./models.js";
/** Parse a decoded JSON value (not JSON text). Unknown/adapter fields do not affect common validity. */
export declare function parseCommonConfig(value: unknown): CommonConfigResult;
/** Follow readable symlinks, but never read directories/devices/FIFOs. Only true ENOENT is absent. */
export declare function readCommonConfigFile(path: string): CommonConfigResult;
/**
 * Metadata shallow-merges per key. envFirst opts into uniform environment-first
 * precedence; by default switches retain the legacy file-first precedence.
 */
export declare function mergeCommonConfig(sources: CommonConfigSources, options?: MergeCommonConfigOptions): MergedCommonConfig;
/** Convert validated canonical FILE replicas only. Legacy SDK environment tuples belong to adapters. */
export declare function toSdkReplicas(replicas: readonly CommonReplica[] | undefined): SdkReplica[] | undefined;
//# sourceMappingURL=common-config.d.ts.map