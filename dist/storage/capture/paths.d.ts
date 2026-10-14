import type { CaptureScope, CaptureStorageRoot, CaptureDirectory } from "./models.js";
export declare function validateIntegration(value: string): void;
export declare function validateIdentifier(value: string, name: string): void;
export declare function identifierHash(value: string): string;
export declare function captureRoot(storage: CaptureStorageRoot): string;
export declare function captureDirectory(storage: CaptureStorageRoot): CaptureDirectory;
export declare function sessionSegments(sessionHash: string): string[];
export declare function eventSegments(storage: CaptureStorageRoot, scope: Pick<CaptureScope, "integration" | "sessionId" | "turnId">): string[];
export declare function sessionsDirectory(root: CaptureStorageRoot, integration: string): string;
export declare function turnsDirectory(root: CaptureStorageRoot, integration: string, sessionHash: string): string;
export declare function eventsDirectory(turns: string, turnHash: string): string;
export declare function eventPath(root: CaptureStorageRoot, scope: CaptureScope): string;
export declare function recordLockPath(root: CaptureStorageRoot, scope: CaptureScope): string;
//# sourceMappingURL=paths.d.ts.map