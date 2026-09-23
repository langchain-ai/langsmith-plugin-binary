import type { BuildPlan, BuildSteps, LoadedConfig } from "./models.js";
export declare function buildPlan({ config, repositoryRoot }: LoadedConfig): BuildPlan;
export declare function requestedArches(plan: BuildPlan, argv: string[]): string[];
export declare function outputPath(plan: BuildPlan, arch: string): string;
export declare function buildArguments(plan: BuildPlan, arch: string, binary: string): string[];
export declare function build(loaded: LoadedConfig, argv: string[], log?: (line: string) => void, steps?: BuildSteps): void;
//# sourceMappingURL=build.d.ts.map