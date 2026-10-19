import type { CommonConfigResult } from "./models.js";
export declare function invalid(raw?: Record<string, unknown>): CommonConfigResult;
export declare function absent(): CommonConfigResult;
/** Parse a decoded JSON value (not JSON text). Unknown/adapter fields do not affect common validity. */
export declare function parseCommonConfig(value: unknown): CommonConfigResult;
//# sourceMappingURL=parse.d.ts.map