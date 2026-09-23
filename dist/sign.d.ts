import type { Environment, LoadedConfig } from "./models.js";
export declare function sign(loaded: LoadedConfig, options?: {
    binaryPath?: string | undefined;
    env?: Environment;
    log?: (line: string) => void;
}): Promise<string>;
//# sourceMappingURL=sign.d.ts.map