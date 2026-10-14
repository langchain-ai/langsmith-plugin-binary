import type { CaptureScope } from "./models.js";
export declare function validateIntegration(value: string): void;
export declare function validateIdentifier(value: string, name: string): void;
export declare function identifierHash(value: string): string;
export declare function sessionSegments(base: string, integration: string, sessionHash: string): string[];
export declare function eventSegments(base: string, scope: Pick<CaptureScope, "integration" | "sessionId" | "turnId">): string[];
export declare function sessionsDirectory(root: string, integration: string): string;
export declare function turnsDirectory(root: string, integration: string, sessionHash: string): string;
export declare function eventsDirectory(turns: string, turnHash: string): string;
export declare function eventPath(root: string, scope: CaptureScope): string;
//# sourceMappingURL=paths.d.ts.map