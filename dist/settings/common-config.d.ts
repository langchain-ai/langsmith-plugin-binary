import type { CommonConfigSources, CommonReplica, MergeCommonConfigOptions, MergedCommonConfig, SdkReplica } from "./models.js";
/**
 * Metadata shallow-merges per key. envFirst opts into uniform environment-first
 * precedence; by default switches retain the legacy file-first precedence.
 */
export declare function mergeCommonConfig(sources: CommonConfigSources, options?: MergeCommonConfigOptions): MergedCommonConfig;
/** Convert validated canonical FILE replicas only. Legacy SDK environment tuples belong to adapters. */
export declare function toSdkReplicas(replicas: readonly CommonReplica[] | undefined): SdkReplica[] | undefined;
//# sourceMappingURL=common-config.d.ts.map