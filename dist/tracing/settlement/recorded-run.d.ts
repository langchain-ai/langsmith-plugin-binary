import type { CodingAgentMetadataOptions } from "../../metadata/models.js";
import type { ProjectedCapture, RecordedRun } from "./models.js";
declare function recordRun(events: ProjectedCapture[]): RecordedRun;
declare function mergeMetadataOptions(captures: readonly ProjectedCapture[]): CodingAgentMetadataOptions;
export { mergeMetadataOptions, recordRun };
//# sourceMappingURL=recorded-run.d.ts.map