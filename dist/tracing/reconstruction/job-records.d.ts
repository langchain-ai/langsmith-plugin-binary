import type { CaptureInput, CaptureScope, StoredCapture } from "../../storage/capture/models.js";
import type { ReconstructionJob, ReconstructionValidatedOutput, StoredReconstructionMapping } from "./models.js";
export declare function snapshotJob(job: ReconstructionJob): ReconstructionJob;
export declare function jobRecord(job: ReconstructionJob): CaptureInput;
export declare function mappingRecord(job: ReconstructionJob, outputs: ReconstructionValidatedOutput[]): CaptureInput;
export declare function readJob(record: StoredCapture, integration: ReconstructionJob["integration"]): ReconstructionJob;
export declare function readMapping(record: StoredCapture): StoredReconstructionMapping;
export declare function sameOutputMapping(mapping: StoredReconstructionMapping, outputs: ReconstructionValidatedOutput[]): boolean;
export declare function mappingScope(job: ReconstructionJob): CaptureScope;
//# sourceMappingURL=job-records.d.ts.map