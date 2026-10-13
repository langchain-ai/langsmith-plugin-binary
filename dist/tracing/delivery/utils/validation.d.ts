import type { CaptureScope } from "../../../storage/capture/models.js";
import type { Dirent } from "node:fs";
import type { DeliveryAttempt } from "../models.js";
export declare function validateAttemptScope(scope: CaptureScope, destination: string): void;
export declare function parseAttempt(contents: string): DeliveryAttempt;
export declare function sameAttempt(record: DeliveryAttempt, scope: CaptureScope, destination: string, attempt: number): boolean;
export declare function validateTimestamp(value: string): void;
export declare function readAttemptFileNumber(entry: Dirent): number | undefined;
export declare function validateAttemptSequence(attempts: number[]): void;
export declare function requireAttemptNumber(value: unknown): number;
//# sourceMappingURL=validation.d.ts.map