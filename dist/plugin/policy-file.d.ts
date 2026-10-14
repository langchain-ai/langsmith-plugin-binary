import type { PolicyFileOptions, PolicyUpdateResult } from "./models.js";
export declare function readPolicyFile<T>(path: string, options: PolicyFileOptions<T>): T;
export declare function updatePolicyFile<T>(path: string, options: PolicyFileOptions<T>, update: (policy: T) => T | void | Promise<void>): Promise<PolicyUpdateResult>;
//# sourceMappingURL=policy-file.d.ts.map