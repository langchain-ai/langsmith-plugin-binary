import type { CodingAgentMetadataOptions } from "../../metadata/models.js";
import type { JsonValue, StoredCapture } from "../../storage/capture/models.js";
import type { ProjectedSubmission } from "../lifecycle/models.js";
import type { ProjectedCapture, SettleCapturedTurnsOptions, TurnEvidenceSnapshot } from "./models.js";
export declare function projectCapture(record: StoredCapture, integration: SettleCapturedTurnsOptions["integration"]): ProjectedCapture | undefined;
export declare function patchPayload(source: ProjectedCapture, metadata: CodingAgentMetadataOptions, integration: SettleCapturedTurnsOptions["integration"], endTime?: number | string, causalRunError?: boolean): ProjectedSubmission;
export declare function addAttribution(metadata: CodingAgentMetadataOptions, attribution: Record<string, string>): CodingAgentMetadataOptions;
export declare function parseEvidence(value: JsonValue, attributionReady: boolean): TurnEvidenceSnapshot;
export declare function closureRank(state: TurnEvidenceSnapshot["closureState"]): number;
//# sourceMappingURL=projection.d.ts.map