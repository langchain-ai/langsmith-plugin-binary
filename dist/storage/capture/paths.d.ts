import type { CaptureScope } from "./models.js";
export declare function validateIntegration(value: string): void;
export declare function validateIdentifier(value: string, name: string): void;
export declare function identifierHash(value: string): string;
export declare function captureDirectory(root: string): string;
export declare function eventPath(root: string, scope: CaptureScope): string;
export declare function receiptPath(root: string, scope: CaptureScope, destination: string): string;
//# sourceMappingURL=paths.d.ts.map