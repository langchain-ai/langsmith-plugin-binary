import type { CodingAgentPrivacyContext, CodingAgentPrivacyStatus } from "../../../privacy/index.js";
import type { NormalizedRunContext, NormalizedRunPatch, NormalizedRunPatchField, NormalizedRunSnapshot } from "../../upload/models.js";
import type { RunIdentity } from "../models.js";
export declare function normalizedRunSnapshot(value: unknown): NormalizedRunSnapshot;
export declare function normalizedRunContext(value: unknown): NormalizedRunContext;
export declare function canonicalIdentity<T extends NormalizedRunContext>(run: T, prior?: NormalizedRunContext, requireStableIdentity?: boolean): T & RunIdentity;
export declare function normalizedPatch(value: unknown): NormalizedRunPatch;
export declare function privacyStatus(value: unknown): CodingAgentPrivacyContext;
export declare function statusForPost(run: NormalizedRunSnapshot): CodingAgentPrivacyStatus;
export declare function normalizePatchValue(value: unknown, field: NormalizedRunPatchField, projected?: boolean): unknown;
//# sourceMappingURL=validation.d.ts.map