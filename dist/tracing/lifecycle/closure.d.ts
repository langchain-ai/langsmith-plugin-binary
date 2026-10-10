import type { CodingAgentIntegration } from "../../metadata/models.js";
import type { StoredCapture } from "../../storage/capture/models.js";
import type { PreparedRunSubmission } from "../upload/models.js";
import type { LifecycleEndTimeWithholdingInput } from "./models.js";
export declare function deriveAttributionReadiness(value: unknown, integration: CodingAgentIntegration): boolean;
export declare function storedAttributionReadiness(record: StoredCapture, integration: CodingAgentIntegration): boolean;
export declare function indexCaptureSources(sources: readonly StoredCapture[]): ReadonlyMap<string, StoredCapture>;
export declare function withholdUnresolvedEndTime(input: LifecycleEndTimeWithholdingInput): Promise<PreparedRunSubmission>;
//# sourceMappingURL=closure.d.ts.map