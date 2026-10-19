import type { CommonConfigFileOptions, CommonConfigFiles, CommonConfigResult } from "./models.js";
/** Follow readable symlinks, but never read directories/devices/FIFOs. Only true ENOENT is absent. */
export declare function readCommonConfigFile(path: string): CommonConfigResult;
export declare function readCommonConfigFiles(options: CommonConfigFileOptions): CommonConfigFiles;
//# sourceMappingURL=config-files.d.ts.map