import type { CaptureScope, CompactedCapturePayload, CompactedFieldDigest, StoredCapture } from "../../../storage/capture/models.js";
import type { NormalizedRunContext, NormalizedRunPatchField, NormalizedRunPatchValues, NormalizedRunSnapshot, RedactedRunField } from "../../upload/models.js";
export declare function payloadObject(record: StoredCapture): Record<string, unknown>;
export declare function readPrivacyMode(payload: Record<string, unknown>): "full" | "metadata";
export declare function storedRun(payload: Record<string, unknown>, runId: string): NormalizedRunSnapshot;
export declare function storedRedactedFields(payload: Record<string, unknown>): readonly RedactedRunField[];
export declare function storedPrivacyStatus(payload: Record<string, unknown>, run: NormalizedRunSnapshot, privacyMode: "full" | "metadata"): "running" | "completed" | "error";
export declare function readPrivacyStatus(value: unknown): "running" | "completed" | "error";
export declare function applySnapshotOmissions(current: NormalizedRunSnapshot, previous: NormalizedRunSnapshot, sourceRun: Record<string, unknown>): NormalizedRunSnapshot;
export declare function snapshotPatchFields(previous: NormalizedRunSnapshot, current: NormalizedRunSnapshot, inputOutputStates: CompactedCapturePayload["fields"], sourceRun: Record<string, unknown>): NormalizedRunPatchField[];
export declare function presentFieldState(value: Record<string, unknown>, field: "inputs" | "outputs"): CompactedFieldDigest;
export declare function sameRunIdentity(left: NormalizedRunSnapshot, right: NormalizedRunSnapshot): boolean;
export declare function runContext(record: StoredCapture): NormalizedRunContext;
export declare function captureScope(record: StoredCapture): CaptureScope;
export declare function sameCanonical(left: unknown, right: unknown): boolean;
export declare function snapshotPatchValues(sourceRun: Record<string, unknown>, fields: readonly NormalizedRunPatchField[]): NormalizedRunPatchValues | undefined;
export declare function readStoredPatchValues(fields: readonly string[], values: Record<string, unknown>): Record<string, unknown> | undefined;
//# sourceMappingURL=snapshot-values.d.ts.map